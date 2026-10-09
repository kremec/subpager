import { cert, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import type { Config } from "./config";
import { isReceptionId, type Outbox, type Reception } from "./outbox";
import { isObject, isRic, type Page } from "./radio/decoder";

export interface RicUnit {
  ric: number;
  unitName: string;
}
export interface CloudDevice {
  uid: string;
  approved: boolean;
  label?: string;
  expoPushToken?: string | null;
}
export interface FirebaseMessage extends Page {
  duplicateOf: string | null;
  location?: string | null;
}

function normalizeContent(content: string) {
  return (
    content
      .replace(/<CR><LF>|<(?:CR|LF)>|\r\n?|\n/g, " ")
      // oxlint-disable-next-line no-control-regex
      .replace(/(?:<(?:EOT|NUL)>|[\x00\x04])+$/, "")
  );
}

const receivedAtFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Ljubljana",
  dateStyle: "short",
  timeStyle: "short",
  hour12: false,
});

export class FirebaseInputError extends Error {
  readonly code = 3;
}

export class FirebaseBackend {
  constructor(readonly db: Firestore) {}

  static async open(config: Config["firebase"]) {
    const account: unknown = await Bun.file(config.serviceAccountPath).json();
    if (!isObject(account) || account.project_id !== config.projectId)
      throw new Error(
        "Firebase service account project does not match projectId",
      );
    const app = initializeApp({
      projectId: config.projectId,
      credential: cert(account as ServiceAccount),
    });
    return new FirebaseBackend(getFirestore(app));
  }

  async ingest(messages: Reception[], notify = true, now = Date.now()) {
    for (const raw of messages) {
      if (
        !isReceptionId(raw.sourceId) ||
        !Number.isFinite(Date.parse(raw.receivedAt)) ||
        !isRic(raw.ric) ||
        !Number.isInteger(raw.function) ||
        raw.function < 0 ||
        raw.function > 3 ||
        !["alpha", "numeric", "tone"].includes(raw.type) ||
        typeof raw.content !== "string"
      )
        throw new FirebaseInputError("Invalid pager reception");
      const { sourceId: messageId, ...page } = raw;
      const message = {
        ...page,
        receivedAt: new Date(raw.receivedAt).toISOString(),
        content: normalizeContent(raw.content),
      };
      await this.db.runTransaction(async (transaction) => {
        const messageRef = this.db.collection("messages").doc(messageId);
        const existing = await transaction.get(messageRef);
        if (existing.exists) {
          const stored = existing.data() as FirebaseMessage;
          if (
            stored.receivedAt !== message.receivedAt ||
            stored.ric !== message.ric ||
            stored.function !== message.function ||
            stored.type !== message.type ||
            normalizeContent(stored.content) !== message.content
          )
            throw new FirebaseInputError(
              `Source ID ${messageId} has conflicting content`,
            );
          return;
        }
        const candidates = await transaction.get(
          this.db
            .collection("messages")
            .where(
              "receivedAt",
              ">=",
              new Date(Date.parse(message.receivedAt) - 30_000).toISOString(),
            )
            .where("receivedAt", "<=", message.receivedAt)
            .orderBy("receivedAt", "desc"),
        );
        const source = candidates.docs.find((document) => {
          const candidate = document.data() as FirebaseMessage;
          return (
            candidate.duplicateOf === null &&
            candidate.ric === message.ric &&
            candidate.function === message.function &&
            candidate.type === message.type &&
            normalizeContent(candidate.content) === message.content
          );
        });
        const duplicateOf = source?.id ?? null;
        const expiresAt = Date.parse(message.receivedAt) + 300_000;
        const fresh = notify && duplicateOf === null && expiresAt > now;
        const users = fresh
          ? await transaction.get(this.db.collection("users"))
          : null;
        const location = source?.get("location") as string | null | undefined;
        transaction.create(messageRef, {
          ...message,
          duplicateOf,
          ...(location !== undefined ? { location } : {}),
        });
        if (
          notify &&
          duplicateOf === null &&
          message.type !== "tone" &&
          message.content.trim()
        ) {
          transaction.create(
            this.db.collection("locationJobs").doc(messageId),
            {
              active: true,
              state: "pending",
              messageId,
              content: message.content,
              nextAttempt: now,
              attempts: 0,
              failures: 0,
              leaseUntil: 0,
            },
          );
        }
        for (const device of users?.docs ?? []) {
          const token = device.get("expoPushToken") as
            | string
            | null
            | undefined;
          if (device.get("approved") !== true || !token) continue;
          transaction.create(this.db.collection("pushJobs").doc(), {
            active: true,
            state: "pending",
            messageId,
            deviceId: device.id,
            expoPushToken: token,
            tokenUpdatedAt: device.updateTime,
            title: `${String(message.ric).padStart(7, "0")} · ${receivedAtFormatter.format(new Date(message.receivedAt))}`,
            body: message.content,
            expiresAt,
            nextAttempt: now,
            attempts: 0,
            leaseUntil: 0,
          });
        }
      });
    }
  }

  async syncRicUnits(units: RicUnit[]) {
    await this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(this.db.collection("ricUnits"));
      const incoming = new Set(units.map((unit) => String(unit.ric)));
      const removed = existing.docs.filter((doc) => !incoming.has(doc.id));
      if (removed.length + units.length > 500)
        throw new FirebaseInputError("RIC synchronization exceeds 500 writes");
      for (const document of removed) transaction.delete(document.ref);
      for (const unit of units)
        transaction.set(
          this.db.collection("ricUnits").doc(String(unit.ric)),
          unit,
        );
    });
  }

  async setMember(uid: string, approved: boolean, label?: string) {
    const name = label?.trim();
    await this.db
      .collection("users")
      .doc(uid)
      .set({ approved, ...(name ? { label: name } : {}) }, { merge: true });
  }

  async devices(): Promise<CloudDevice[]> {
    const users = await this.db.collection("users").get();
    return users.docs.map((doc) => ({
      uid: doc.id,
      approved: doc.get("approved") === true,
      label: doc.get("label") as string | undefined,
      expoPushToken: (doc.get("expoPushToken") as string | null) ?? null,
    }));
  }
}

export class FirebaseWorker {
  lastError: string | null = null;
  private retryAt = 0;
  private failures = 0;
  private running: Promise<void> | undefined;

  constructor(
    private outbox: Outbox,
    private backend: Pick<FirebaseBackend, "ingest">,
  ) {}

  tick(now = Date.now()): Promise<void> {
    if (this.running) return this.running;
    if (now < this.retryAt) return Promise.resolve();
    this.running = this.upload(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async upload(now: number) {
    const startedAt = Date.now();
    try {
      const pending = this.outbox.pending();
      if (!pending.length) return;
      await this.backend.ingest(pending.map((item) => item.reception));
      this.outbox.acknowledge(pending);
      this.lastError = null;
      this.failures = 0;
      this.retryAt = 0;
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Firebase upload failed";
      this.failures++;
      const code = isObject(error) ? error.code : undefined;
      this.retryAt =
        now +
        Math.max(0, Date.now() - startedAt) +
        ([
          3,
          7,
          16,
          "invalid-argument",
          "permission-denied",
          "unauthenticated",
        ].includes(code as number | string)
          ? 3_600_000
          : Math.min(300_000, 15_000 * 2 ** Math.min(this.failures - 1, 5)));
    }
  }
}

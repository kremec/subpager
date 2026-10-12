import { cert, initializeApp, type ServiceAccount } from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";
import { FirestoreUsers } from "./users";
import type { Config } from "./config";
import { isReceptionId, type Outbox, type Reception } from "./outbox";
import { isObject, isRic, type Page } from "./radio/decoder";
import { SPIN_MATCHING_HORIZON } from "./spin";
import {
  canGroupPages,
  GROUPING_WINDOW_MS,
  normalizeContent,
} from "./pager-group";

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
  rics: number[];
  sourceIds: string[];
  location?: string | null;
  spinEventId?: string;
  spinMatchStatus?: "provisional" | "confirmed";
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
  constructor(
    readonly db: Firestore,
    readonly users = new FirestoreUsers(db),
  ) {}

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
      if (notify) await this.users.ready();
      await this.db.runTransaction(async (transaction) => {
        const messageRef = this.db.collection("messages").doc(messageId);
        const seen = await transaction.get(
          this.db
            .collection("messages")
            .where("sourceIds", "array-contains", messageId)
            .limit(1),
        );
        const existing = seen.docs[0];
        if (existing) {
          if (existing.get("deleted") === true) return;
          // Source IDs are immutable. Only the anchor retains the original payload.
          if (existing.id !== messageId) return;
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
              new Date(
                Date.parse(message.receivedAt) - GROUPING_WINDOW_MS,
              ).toISOString(),
            )
            .where(
              "receivedAt",
              "<=",
              new Date(
                Date.parse(message.receivedAt) + GROUPING_WINDOW_MS,
              ).toISOString(),
            )
            .orderBy("receivedAt", "asc"),
        );
        const source = candidates.docs.find((document) => {
          const candidate = document.data() as FirebaseMessage;
          return (
            document.get("deleted") !== true &&
            canGroupPages(candidate, message)
          );
        });
        if (source) {
          const stored = source.data() as FirebaseMessage;
          transaction.update(source.ref, {
            rics: [...new Set([...stored.rics, message.ric])],
            sourceIds: [...stored.sourceIds, messageId],
            updatedAt: FieldValue.serverTimestamp(),
          });
          return;
        }
        const expiresAt = Date.parse(message.receivedAt) + 300_000;
        const fresh = notify && expiresAt > now;
        const recipients = fresh ? this.users.recipients() : [];
        transaction.create(messageRef, {
          ...message,
          rics: [message.ric],
          sourceIds: [messageId],
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (notify && message.type !== "tone" && message.content.trim()) {
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
          transaction.create(this.db.collection("spinJobs").doc(messageId), {
            active: true,
            state: "pending",
            expiresAt: Date.parse(message.receivedAt) + SPIN_MATCHING_HORIZON,
            nextAttempt: now,
            attempts: 0,
            failures: 0,
            leaseUntil: 0,
          });
        }
        for (let offset = 0; offset < recipients.length; offset += 100) {
          transaction.create(this.db.collection("pushJobs").doc(), {
            active: true,
            state: "pending",
            messageId,
            recipients: recipients
              .slice(offset, offset + 100)
              .map((recipient) => ({
                ...recipient,
                state: "pending",
                nextAttempt: now,
                attempts: 0,
              })),
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

  async deleteMessage(messageId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(messageId))
      throw new FirebaseInputError("Invalid message ID");
    await this.db.runTransaction(async (transaction) => {
      const [seen, pushes] = await Promise.all([
        transaction.get(
          this.db
            .collection("messages")
            .where("sourceIds", "array-contains", messageId),
        ),
        transaction.get(
          this.db.collection("pushJobs").where("active", "==", true),
        ),
      ]);
      const message =
        seen.docs[0] ??
        (await transaction.get(this.db.collection("messages").doc(messageId)));
      const messageRef = message.ref;
      const canonicalId = message.id;
      if (!message.exists) throw new FirebaseInputError("Message is missing");
      if (message.get("deleted") !== true) {
        // Keep the original payload readable by older app bundles during rollout.
        // Retain the marker so phones returning from offline can remove their copy.
        transaction.update(messageRef, {
          deleted: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      transaction.delete(this.db.collection("locationJobs").doc(canonicalId));
      transaction.delete(this.db.collection("spinJobs").doc(canonicalId));
      for (const push of pushes.docs)
        if (push.get("messageId") === canonicalId) transaction.delete(push.ref);
    });
  }

  async syncRicUnits(units: RicUnit[]) {
    const collection = this.db.collection("ricUnits");
    const existing = await collection.get();
    const ids = new Set(units.map((unit) => String(unit.ric)));
    const writer = this.db.bulkWriter();
    try {
      await Promise.all([
        ...units.map((unit) =>
          writer.set(collection.doc(String(unit.ric)), unit),
        ),
        ...existing.docs
          .filter((doc) => !ids.has(doc.id))
          .map((doc) => writer.delete(doc.ref)),
      ]);
    } finally {
      await writer.close();
    }
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

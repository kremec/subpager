import { cert, initializeApp, type ServiceAccount } from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";
import { withoutEchoes } from "../../shared/pager-receptions";
import { FirestoreUsers } from "./users";
import type { Config } from "./config";
import { isReceptionId, type Outbox, type Reception } from "./outbox";
import { isObject, isRic, type Page } from "./radio/decoder";
import { SPIN_MATCHING_HORIZON } from "./spin";
import {
  canGroupPages,
  isEcho,
  normalizeContent,
  pagerDay,
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
export interface PagerReception {
  ric: number;
  time: string;
}
export interface FirebaseMessage extends Omit<Page, "ric" | "receivedAt"> {
  receptions: PagerReception[];
  location?: string | null;
  locationAddress?: string | null;
  spinEventId?: string;
  spinMatchStatus?: "provisional" | "confirmed";
}

function startsNotificationBatch(receptions: PagerReception[], time: string) {
  const receivedAt = Date.parse(time);
  let start = -Infinity;
  for (const reception of receptions) {
    const at = Date.parse(reception.time);
    if (at > receivedAt)
      return at - receivedAt > 180_000 && receivedAt - start > 180_000;
    if (at - start > 180_000) start = at;
  }
  return receivedAt - start > 180_000;
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
      if (raw.type === "tone") continue;
      const { sourceId: messageId, ric, receivedAt, ...fields } = raw;
      const reception = { ric, time: new Date(receivedAt).toISOString() };
      const message: FirebaseMessage = {
        ...fields,
        content: normalizeContent(raw.content),
        receptions: [reception],
      };
      const day = pagerDay(reception.time);
      if (notify) await this.users.ready();
      await this.db.runTransaction(async (transaction) => {
        const messageRef = this.db.collection("messages").doc(messageId);
        const existing = await transaction.get(messageRef);
        if (existing.exists) {
          if (existing.get("deleted") === true) return;
          const stored = existing.data() as FirebaseMessage;
          if (
            pagerDay(stored.receptions[0]!.time) !== day ||
            !isEcho(withoutEchoes(stored.receptions), reception) ||
            stored.function !== message.function ||
            stored.type !== message.type ||
            normalizeContent(stored.content) !== message.content
          )
            throw new FirebaseInputError(
              `Source ID ${messageId} has conflicting content`,
            );
          return;
        }
        // Matching content defines one event per Ljubljana calendar day.
        const events = await transaction.get(this.db.collection("messages"));
        const matched = events.docs.filter(
          (doc) =>
            canGroupPages(doc.data() as FirebaseMessage, message) &&
            pagerDay((doc.get("receptions") as PagerReception[])[0]!.time) ===
              day,
        );
        if (
          matched.some((doc) =>
            isEcho(
              withoutEchoes(doc.get("receptions") as PagerReception[]),
              reception,
            ),
          )
        )
          return;
        const source = matched
          .filter((doc) => doc.get("deleted") !== true)
          .sort((a, b) => {
            const first = (a.get("receptions") as PagerReception[])[0]!.time;
            const second = (b.get("receptions") as PagerReception[])[0]!.time;
            return first.localeCompare(second) || a.id.localeCompare(b.id);
          })[0];
        const stored = source?.data() as FirebaseMessage | undefined;
        const receptions = stored ? withoutEchoes(stored.receptions) : [];
        const eventId = source?.id ?? messageId;
        const expiresAt = Date.parse(reception.time) + 300_000;
        const newBatch =
          !stored || startsNotificationBatch(receptions, reception.time);
        const fresh = notify && newBatch && expiresAt > now;
        const recipients = fresh
          ? this.users.recipients(undefined, message.content)
          : [];
        const infer = notify && newBatch && message.content.trim();
        const spinRef = this.db.collection("spinJobs").doc(eventId);
        const spinJob =
          infer && source ? await transaction.get(spinRef) : undefined;
        if (source) {
          transaction.update(source.ref, {
            receptions: [...receptions, reception].sort((a, b) =>
              a.time.localeCompare(b.time),
            ),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else
          transaction.create(messageRef, {
            ...message,
            updatedAt: FieldValue.serverTimestamp(),
          });
        if (infer) {
          if (!source)
            transaction.create(
              this.db.collection("locationJobs").doc(eventId),
              {
                active: true,
                state: "pending",
                messageId: eventId,
                content: message.content,
                nextAttempt: now,
                attempts: 0,
                failures: 0,
                leaseUntil: 0,
              },
            );
          // A later paging session can refresh its incident context; keep paid ready results.
          if (spinJob?.get("state") === "ready")
            transaction.update(spinRef, {
              active: true,
              expiresAt: Date.parse(reception.time) + SPIN_MATCHING_HORIZON,
              reviewAfterPublish: true,
            });
          else
            transaction.set(spinRef, {
              active: true,
              state: "pending",
              expiresAt: Date.parse(reception.time) + SPIN_MATCHING_HORIZON,
              nextAttempt: now,
              attempts: (spinJob?.get("attempts") ?? 0) + (source ? 1 : 0),
              failures: 0,
              leaseUntil: 0,
              ...(stored?.spinEventId
                ? { reviewEventId: stored.spinEventId }
                : {}),
            });
        }
        for (let offset = 0; offset < recipients.length; offset += 100) {
          transaction.create(this.db.collection("pushJobs").doc(), {
            active: true,
            state: "pending",
            messageId: eventId,
            recipients: recipients
              .slice(offset, offset + 100)
              .map((recipient) => ({
                ...recipient,
                state: "pending",
                nextAttempt: now,
                attempts: 0,
              })),
            title: `${String(ric).padStart(7, "0")} · ${receivedAtFormatter.format(new Date(reception.time))}`,
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
      const [message, pushes] = await Promise.all([
        transaction.get(this.db.collection("messages").doc(messageId)),
        transaction.get(
          this.db.collection("pushJobs").where("active", "==", true),
        ),
      ]);
      if (!message.exists) throw new FirebaseInputError("Message is missing");
      const messageRef = message.ref;
      const canonicalId = message.id;
      if (message.get("deleted") !== true) {
        // Retain reception history so retries cannot recreate a deleted event.
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

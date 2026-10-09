import {
  FieldValue,
  type Firestore,
  type Timestamp,
} from "firebase-admin/firestore";
import { isObject } from "./radio/decoder";
import { createErrorReporter } from "./log";
import { FirestoreUsers } from "./users";

export type PushState = "pending" | "receipt" | "sent" | "failed" | "expired";

export interface PushRecipient {
  deviceId: string;
  expoPushToken: string;
  tokenUpdatedAt: Timestamp;
  state: PushState;
  nextAttempt: number;
  attempts: number;
  ticketId?: string;
  receiptExpiresAt?: number;
  lastError?: string;
}

export interface PushJob {
  active: boolean;
  state: PushState;
  messageId: string;
  title: string;
  body: string;
  expiresAt: number;
  nextAttempt: number;
  attempts: number;
  leaseUntil: number;
  recipients: PushRecipient[];
  lastError?: string;
}

interface ClaimedPush extends PushJob {
  id: string;
}
interface PushUpdate {
  job: ClaimedPush;
  disableTokens: PushRecipient[];
}
type HttpRequest = (url: string, options: RequestInit) => Promise<Response>;

function scheduled(job: PushJob) {
  const active = job.recipients.filter(
    (recipient) =>
      recipient.state === "pending" || recipient.state === "receipt",
  );
  const state: PushState = active.some(
    (recipient) => recipient.state === "pending",
  )
    ? "pending"
    : active.length
      ? "receipt"
      : job.recipients.some((recipient) => recipient.state === "sent")
        ? "sent"
        : job.recipients.some((recipient) => recipient.state === "failed")
          ? "failed"
          : "expired";
  return {
    active: active.length > 0,
    state,
    nextAttempt: active.length
      ? Math.min(...active.map((recipient) => recipient.nextAttempt))
      : 0,
  };
}

export function expoError(payload: Record<string, unknown>) {
  const details = isObject(payload.details) ? payload.details : {};
  return typeof details.error === "string" &&
    [
      "DeviceNotRegistered",
      "MessageTooBig",
      "InvalidCredentials",
      "MismatchSenderId",
      "MessageRateExceeded",
    ].includes(details.error)
    ? details.error
    : "Expo notification error";
}

export class PushDelivery {
  private updates = new Map<string, PushUpdate>();
  private report = createErrorReporter("Push delivery");
  private nextSendAt = 0;

  constructor(
    private db: Firestore,
    private request: HttpRequest = fetch,
    private accessToken?: string,
    private users = new FirestoreUsers(db),
  ) {}

  private async post(endpoint: string, body: object) {
    const response = await this.request(
      `https://exp.host/--/api/v2/push/${endpoint}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.accessToken
            ? { authorization: `Bearer ${this.accessToken}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Expo HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!isObject(payload) || payload.errors)
      throw new Error("Invalid Expo response");
    return payload.data;
  }

  private deadline(job: PushJob, recipient: PushRecipient) {
    return recipient.state === "receipt"
      ? recipient.receiptExpiresAt!
      : job.expiresAt;
  }

  private async claim(id: string): Promise<ClaimedPush | null> {
    const ref = this.db.collection("pushJobs").doc(id);
    return this.db.runTransaction(async (tx) => {
      const stored = (await tx.get(ref)).data() as PushJob | undefined;
      const now = Date.now();
      if (
        !stored?.active ||
        stored.nextAttempt > now ||
        stored.leaseUntil > now
      )
        return null;
      const job = {
        ...stored,
        id,
        recipients: stored.recipients.map((recipient) => ({ ...recipient })),
        attempts: stored.attempts + 1,
        leaseUntil: now + 30_000,
      };
      for (const recipient of job.recipients) {
        if (recipient.state !== "pending" && recipient.state !== "receipt")
          continue;
        if (this.deadline(job, recipient) <= now) recipient.state = "expired";
        else if (recipient.nextAttempt <= now) recipient.attempts++;
      }
      const schedule = scheduled(job);
      tx.update(ref, {
        ...schedule,
        recipients: job.recipients,
        attempts: job.attempts,
        leaseUntil: schedule.active ? job.leaseUntil : 0,
      });
      return schedule.active ? job : null;
    });
  }

  private retry(
    job: PushJob,
    recipient: PushRecipient,
    state: "pending" | "receipt",
    error: string,
  ) {
    const now = Date.now();
    recipient.state = state;
    recipient.state = this.deadline(job, recipient) > now ? state : "expired";
    recipient.nextAttempt =
      now + Math.min(60_000, 1000 * 2 ** Math.min(recipient.attempts - 1, 6));
    recipient.lastError = error;
  }

  private failure(
    job: PushJob,
    recipient: PushRecipient,
    payload: Record<string, unknown>,
    disableTokens: PushRecipient[],
  ) {
    const error = expoError(payload);
    if (
      [
        "DeviceNotRegistered",
        "MessageTooBig",
        "InvalidCredentials",
        "MismatchSenderId",
      ].includes(error)
    ) {
      recipient.state = "failed";
      recipient.lastError = error;
      if (error === "DeviceNotRegistered") disableTokens.push(recipient);
    } else this.retry(job, recipient, "pending", error);
  }

  private async flush() {
    for (const [id, update] of this.updates) {
      await this.db.runTransaction(async (tx) => {
        const ref = this.db.collection("pushJobs").doc(id);
        const current = (await tx.get(ref)).data() as PushJob | undefined;
        if (!current?.active || current.attempts !== update.job.attempts)
          return;
        const refs = update.disableTokens.map((recipient) =>
          this.db.collection("users").doc(recipient.deviceId),
        );
        const devices = refs.length ? await tx.getAll(...refs) : [];
        const lastError = update.job.recipients.find(
          (recipient) => recipient.lastError,
        )?.lastError;
        if (
          update.job.recipients.every((recipient) => recipient.state === "sent")
        )
          tx.delete(ref);
        else
          tx.update(ref, {
            ...scheduled(update.job),
            recipients: update.job.recipients,
            leaseUntil: 0,
            ...(lastError ? { lastError } : {}),
          });
        for (const [index, recipient] of update.disableTokens.entries()) {
          const device = devices[index]!;
          if (
            device.get("expoPushToken") === recipient.expoPushToken &&
            device.updateTime?.isEqual(recipient.tokenUpdatedAt)
          )
            tx.update(refs[index]!, { expoPushToken: FieldValue.delete() });
        }
      });
      this.updates.delete(id);
    }
  }

  async run(ids: string[]) {
    // Keep accepted tickets until Firestore acknowledges their writes.
    await this.flush();
    const id = ids[0];
    if (!id) return;
    await this.users.ready();
    // Throttle before claiming, so waiting never consumes the job's lease.
    if (this.nextSendAt > Date.now())
      await Bun.sleep(this.nextSendAt - Date.now());
    const job = await this.claim(id);
    if (!job) return;
    const disableTokens: PushRecipient[] = [];
    for (const state of ["pending", "receipt"] as const) {
      let recipients = job.recipients.filter(
        (recipient) =>
          recipient.state === state && recipient.nextAttempt <= Date.now(),
      );
      if (state === "pending" && recipients.length) {
        // A disconnected roster must pause delivery, never authorize old data.
        try {
          recipients = recipients.filter((recipient) => {
            if (this.users.authorized(recipient)) return true;
            recipient.state = "failed";
            recipient.lastError = "Device approval or token changed";
            return false;
          });
        } catch (error) {
          for (const recipient of recipients)
            this.retry(
              job,
              recipient,
              state,
              error instanceof Error
                ? error.message
                : "User listener disconnected",
            );
          continue;
        }
      }
      recipients = recipients.filter((recipient) => {
        if (this.deadline(job, recipient) > Date.now()) return true;
        recipient.state = "expired";
        return false;
      });
      if (!recipients.length) continue;
      if (job.leaseUntil - Date.now() < 10_000) {
        for (const recipient of recipients)
          this.retry(
            job,
            recipient,
            state,
            "Push lease is too close to expiry",
          );
        continue;
      }
      let data: unknown;
      try {
        if (state === "pending") this.nextSendAt = Date.now() + 167;
        data = await this.post(
          state === "pending" ? "send" : "getReceipts",
          state === "pending"
            ? recipients.map((recipient) => ({
                to: recipient.expoPushToken,
                title: job.title,
                body: job.body,
                data: { messageId: job.messageId },
                sound: "default",
                priority: "high",
                channelId: "pager-alerts",
                ttl: Math.max(
                  1,
                  Math.ceil((job.expiresAt - Date.now()) / 1000),
                ),
              }))
            : { ids: recipients.map((recipient) => recipient.ticketId) },
        );
        if (
          (state === "pending" && !Array.isArray(data)) ||
          (state === "receipt" && !isObject(data))
        )
          throw new Error("Invalid Expo ticket or receipt response");
      } catch (error) {
        for (const recipient of recipients)
          this.retry(
            job,
            recipient,
            state,
            error instanceof Error ? error.message : "Expo request failed",
          );
        continue;
      }
      for (const [index, recipient] of recipients.entries()) {
        const result: unknown = Array.isArray(data)
          ? data[index]
          : isObject(data)
            ? data[recipient.ticketId!]
            : null;
        if (!isObject(result))
          this.retry(job, recipient, state, "Expo result not available");
        else if (result.status === "error")
          this.failure(job, recipient, result, disableTokens);
        else if (result.status === "ok" && state === "receipt")
          recipient.state = "sent";
        else if (
          result.status === "ok" &&
          typeof result.id === "string" &&
          result.id.trim()
        ) {
          const now = Date.now();
          recipient.state = "receipt";
          recipient.ticketId = result.id;
          recipient.nextAttempt = now + 15 * 60_000;
          recipient.receiptExpiresAt = now + 24 * 3_600_000;
        } else this.retry(job, recipient, state, "Invalid Expo result");
      }
    }
    this.updates.set(id, { job, disableTokens });
    this.report(
      job.recipients.find((recipient) => recipient.lastError)?.lastError ??
        null,
    );
    await this.flush();
  }
}

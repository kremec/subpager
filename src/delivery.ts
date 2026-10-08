import {
  FieldValue,
  type Firestore,
  type Timestamp,
} from "firebase-admin/firestore";
import { isObject } from "./radio/decoder";
import { createErrorReporter } from "./log";

export interface PushJob {
  active: boolean;
  state: "pending" | "receipt" | "sent" | "failed" | "expired";
  messageId: string;
  deviceId: string;
  expoPushToken: string;
  tokenUpdatedAt: Timestamp;
  title: string;
  body: string;
  expiresAt: number;
  nextAttempt: number;
  attempts: number;
  leaseUntil: number;
  ticketId?: string;
  receiptExpiresAt?: number;
  lastError?: string;
}

interface ClaimedPush extends PushJob {
  id: string;
}
interface PushUpdate {
  job: ClaimedPush;
  patch: Partial<PushJob>;
  disableToken?: boolean;
}
type HttpRequest = (url: string, options: RequestInit) => Promise<Response>;

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

  constructor(
    private db: Firestore,
    private request: HttpRequest = fetch,
    private accessToken?: string,
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

  private async claim(id: string): Promise<ClaimedPush | null> {
    const ref = this.db.collection("pushJobs").doc(id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const job = snapshot.data() as PushJob | undefined;
      const now = Date.now();
      if (!job?.active || job.nextAttempt > now || job.leaseUntil > now)
        return null;
      const deadline =
        job.state === "receipt" ? job.receiptExpiresAt! : job.expiresAt;
      if (deadline <= now) {
        tx.update(ref, { active: false, state: "expired", leaseUntil: 0 });
        return null;
      }
      if (job.state === "pending") {
        const [device, member] = await Promise.all([
          tx.get(this.db.collection("devices").doc(job.deviceId)),
          tx.get(this.db.collection("members").doc(job.deviceId)),
        ]);
        if (
          member.get("approved") !== true ||
          device.get("expoPushToken") !== job.expoPushToken
        ) {
          tx.update(ref, {
            active: false,
            state: "failed",
            leaseUntil: 0,
            lastError: "Device approval or token changed",
          });
          return null;
        }
      }
      const claimed = {
        ...job,
        id,
        attempts: job.attempts + 1,
        leaseUntil: now + 30_000,
      };
      tx.update(ref, {
        attempts: claimed.attempts,
        leaseUntil: claimed.leaseUntil,
      });
      return claimed;
    });
  }

  private update(
    job: ClaimedPush,
    patch: Partial<PushJob>,
    disableToken = false,
  ) {
    this.updates.set(job.id, {
      job,
      patch: { ...patch, leaseUntil: 0 },
      disableToken,
    });
  }

  private retry(job: ClaimedPush, state: "pending" | "receipt", error: string) {
    const now = Date.now();
    const deadline =
      state === "receipt" ? job.receiptExpiresAt! : job.expiresAt;
    this.update(job, {
      active: deadline > now,
      state: deadline > now ? state : "expired",
      nextAttempt:
        now + Math.min(60_000, 1000 * 2 ** Math.min(job.attempts - 1, 6)),
      lastError: error,
    });
  }

  private failure(job: ClaimedPush, payload: Record<string, unknown>) {
    const error = expoError(payload);
    if (
      [
        "DeviceNotRegistered",
        "MessageTooBig",
        "InvalidCredentials",
        "MismatchSenderId",
      ].includes(error)
    ) {
      this.update(
        job,
        { active: false, state: "failed", lastError: error },
        error === "DeviceNotRegistered",
      );
    } else this.retry(job, "pending", error);
  }

  private async flush() {
    for (const [id, update] of this.updates) {
      await this.db.runTransaction(async (tx) => {
        const ref = this.db.collection("pushJobs").doc(id);
        const current = (await tx.get(ref)).data() as PushJob | undefined;
        if (!current?.active || current.attempts !== update.job.attempts)
          return;
        const deviceRef = this.db
          .collection("devices")
          .doc(update.job.deviceId);
        const device = update.disableToken ? await tx.get(deviceRef) : null;
        tx.update(ref, update.patch);
        if (
          device?.get("expoPushToken") === update.job.expoPushToken &&
          device.updateTime?.isEqual(update.job.tokenUpdatedAt)
        )
          tx.update(deviceRef, { expoPushToken: FieldValue.delete() });
      });
      this.updates.delete(id);
    }
  }

  async run(ids: string[]) {
    // Keep accepted tickets in memory until Firestore acknowledges their writes.
    await this.flush();
    const claimed = (
      await Promise.all(ids.slice(0, 100).map((id) => this.claim(id)))
    ).filter((job): job is ClaimedPush => job !== null);
    for (const state of ["pending", "receipt"] as const) {
      const candidates = claimed.filter((job) => job.state === state);
      // Refresh the whole batch atomically so early jobs do not outlive their
      // leases while later jobs wait for individual authorization reads.
      let jobs = candidates.length
        ? await this.db.runTransaction(async (tx) => {
            const refs = candidates.map((job) =>
              this.db.collection("pushJobs").doc(job.id),
            );
            const snapshots = await tx.getAll(...refs);
            const deviceRefs = candidates.map((job) =>
              this.db.collection("devices").doc(job.deviceId),
            );
            const memberRefs = candidates.map((job) =>
              this.db.collection("members").doc(job.deviceId),
            );
            const devices =
              state === "pending" ? await tx.getAll(...deviceRefs) : [];
            const members =
              state === "pending" ? await tx.getAll(...memberRefs) : [];
            const now = Date.now();
            return candidates.filter((job, index) => {
              const current = snapshots[index]!.data() as PushJob | undefined;
              if (
                !current?.active ||
                current.attempts !== job.attempts ||
                current.state !== state
              )
                return false;
              const deadline =
                state === "pending" ? job.expiresAt : job.receiptExpiresAt!;
              const authorized =
                state === "receipt" ||
                (members[index]!.get("approved") === true &&
                  devices[index]!.get("expoPushToken") === job.expoPushToken);
              if (!authorized || deadline <= now) {
                tx.update(refs[index]!, {
                  active: false,
                  state: deadline <= now ? "expired" : "failed",
                  leaseUntil: 0,
                });
                return false;
              }
              tx.update(refs[index]!, { leaseUntil: now + 30_000 });
              return true;
            });
          })
        : [];
      jobs = jobs.filter((job) => {
        const deadline =
          state === "pending" ? job.expiresAt : job.receiptExpiresAt!;
        if (deadline > Date.now()) return true;
        this.update(job, { active: false, state: "expired" });
        return false;
      });
      if (!jobs.length) continue;
      let data: unknown;
      try {
        data = await this.post(
          state === "pending" ? "send" : "getReceipts",
          state === "pending"
            ? jobs.map((job) => ({
                to: job.expoPushToken,
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
            : { ids: jobs.map((job) => job.ticketId) },
        );
        if (
          (state === "pending" && !Array.isArray(data)) ||
          (state === "receipt" && !isObject(data))
        )
          throw new Error("Invalid Expo ticket or receipt response");
      } catch (error) {
        for (const job of jobs)
          this.retry(
            job,
            state,
            error instanceof Error ? error.message : "Expo request failed",
          );
        continue;
      }
      for (const [index, job] of jobs.entries()) {
        const result: unknown = Array.isArray(data)
          ? data[index]
          : isObject(data)
            ? data[job.ticketId!]
            : null;
        if (!isObject(result))
          this.retry(job, state, "Expo result not available");
        else if (result.status === "error") this.failure(job, result);
        else if (result.status === "ok" && state === "receipt")
          this.update(job, { active: false, state: "sent" });
        else if (
          result.status === "ok" &&
          typeof result.id === "string" &&
          result.id.trim()
        ) {
          const now = Date.now();
          this.update(job, {
            state: "receipt",
            ticketId: result.id,
            nextAttempt: now + 15 * 60_000,
            receiptExpiresAt: now + 24 * 3_600_000,
          });
        } else this.retry(job, state, "Invalid Expo result");
      }
    }
    this.report(
      [...this.updates.values()].find((update) => update.patch.lastError)?.patch
        .lastError ?? null,
    );
    await this.flush();
  }
}

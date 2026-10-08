import { isObject } from "./radio/decoder";
import type { Store, PushJob } from "./store";

type HttpRequest = (url: string, options: RequestInit) => Promise<Response>;

const receivedAtFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "short",
  timeStyle: "short",
  hour12: false,
  timeZone: "Europe/Ljubljana",
});

export class PushWorker {
  lastError: string | null = null;
  private running: Promise<void> | undefined;
  constructor(
    private store: Store,
    private request: HttpRequest = fetch,
    private accessToken = process.env.EXPO_ACCESS_TOKEN,
    private authorize?: (job: PushJob) => Promise<boolean>,
  ) {}

  private async post(endpoint: string, body: object) {
    const result = await this.request(
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
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!result.ok) {
      await result.body?.cancel().catch(() => {});
      throw new Error(`Expo HTTP ${result.status}`);
    }
    const payload: unknown = await result.json();
    if (!isObject(payload) || payload.errors)
      throw new Error("Expo returned an invalid response or request error");
    return payload.data;
  }

  private retry(
    job: PushJob,
    state: "pending" | "receipt",
    now: number,
    error: string,
  ) {
    now = Math.max(now, Date.now());
    const delay = Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6));
    const expired = state === "pending" && now >= job.expiresAt;
    this.store.setJob(job, expired ? "expired" : state, now + delay, error);
    this.lastError = error;
    return error;
  }

  private failure(job: PushJob, payload: Record<string, unknown>, now: number) {
    const details = isObject(payload.details) ? payload.details : {};
    const error =
      typeof details.error === "string" &&
      [
        "DeviceNotRegistered",
        "MessageTooBig",
        "InvalidCredentials",
        "MismatchSenderId",
        "MessageRateExceeded",
      ].includes(details.error)
        ? details.error
        : "Expo notification error";
    if (
      error === "DeviceNotRegistered" ||
      ["MessageTooBig", "InvalidCredentials", "MismatchSenderId"].includes(
        error,
      )
    ) {
      this.store.setJob(job, "failed", now, error);
      if (error === "DeviceNotRegistered")
        this.store.disablePush(
          job.deviceId,
          job.expoPushToken,
          job.deviceUpdateTime,
        );
    } else if (!this.store.isSubscribed(job)) {
      this.store.setJob(
        job,
        "failed",
        now,
        "Subscription changed before retry",
      );
    } else {
      this.retry(job, "pending", now, error);
    }
    this.lastError = error;
    return error;
  }

  tick(now = Date.now()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.deliver(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async deliver(now: number) {
    let tickError: string | null = null;
    let providerSucceeded = false;
    const pending = this.store.dueJobs("pending", now);
    const authorized = this.authorize
      ? await Promise.all(
          pending.map(async (job) => {
            if (this.authorize) {
              try {
                if (!(await this.authorize(job))) {
                  this.store.setJob(
                    job,
                    "failed",
                    now,
                    "Device approval or subscription changed",
                  );
                  return null;
                }
                if (job.expiresAt <= Date.now()) {
                  this.store.setJob(
                    job,
                    "expired",
                    now,
                    "Alert expired during authorization",
                  );
                  return null;
                }
              } catch {
                tickError = this.retry(
                  job,
                  "pending",
                  now,
                  "Could not check device approval",
                );
                return null;
              }
            }
            return job;
          }),
        )
      : pending;
    const sentAt = this.authorize ? Math.max(now, Date.now()) : now;
    const jobs = authorized.filter((job): job is PushJob => {
      if (!job || !this.store.isSubscribed(job)) return false;
      if (job.expiresAt > sentAt) return true;
      this.store.setJob(
        job,
        "expired",
        sentAt,
        "Alert expired before delivery",
      );
      return false;
    });
    if (jobs.length) {
      let tickets: unknown[] | undefined;
      try {
        const response = await this.post(
          "send",
          jobs.map((job) => ({
            to: job.expoPushToken,
            title: `${String(job.ric).padStart(7, "0")} · ${receivedAtFormatter.format(new Date(job.receivedAt))}`,
            body: job.content,
            data: { messageId: job.messageId },
            sound: "default",
            priority: "high",
            channelId: "pager-alerts",
            ttl: Math.max(1, Math.ceil((job.expiresAt - sentAt) / 1000)),
          })),
        );
        if (!Array.isArray(response) || response.length !== jobs.length)
          throw new Error("Expo ticket count mismatch");
        tickets = response;
        providerSucceeded = true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Push request failed";
        for (const job of jobs)
          tickError = this.retry(job, "pending", now, message);
      }
      tickets?.forEach((ticket: unknown, index: number) => {
        const job = jobs[index]!;
        if (!isObject(ticket)) {
          tickError = this.retry(job, "pending", now, "Invalid push ticket");
          return;
        }
        if (ticket.status === "ok" && typeof ticket.id === "string") {
          this.store.setJob(
            job,
            "receipt",
            sentAt + 15 * 60000,
            null,
            ticket.id,
            job.expoPushToken,
            sentAt,
          );
        } else if (ticket.status === "error")
          tickError = this.failure(job, ticket, now);
        else tickError = this.retry(job, "pending", now, "Invalid push ticket");
      });
    }
    const receipts = this.store.dueJobs("receipt", now);
    if (receipts.length) {
      let results: Record<string, unknown> | undefined;
      try {
        const response = await this.post("getReceipts", {
          ids: receipts.map((job) => job.ticketId),
        });
        if (!isObject(response))
          throw new Error("Invalid push receipt response");
        results = response;
        providerSucceeded = true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Receipt request failed";
        for (const job of receipts)
          tickError = this.retry(job, "receipt", now, message);
      }
      if (results) {
        for (const job of receipts) {
          const receipt = results[job.ticketId!];
          if (!isObject(receipt))
            tickError = this.retry(
              job,
              "receipt",
              now,
              "Push receipt not available",
            );
          else if (receipt.status === "ok")
            this.store.setJob(job, "sent", now, null);
          else if (receipt.status === "error")
            tickError = this.failure(job, receipt, now);
          else
            tickError = this.retry(job, "receipt", now, "Invalid push receipt");
        }
      }
    }
    if (providerSucceeded) this.lastError = tickError;
  }
}

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";

type TransportJob = Doc<"pushJobs"> & {
  message: Doc<"messages">;
  authorized: boolean;
};

const ids = { jobIds: v.array(v.id("pushJobs")) };
const claims = {
  jobs: v.array(v.object({ jobId: v.id("pushJobs"), attempt: v.number() })),
};
const receivedAtFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "short",
  timeStyle: "short",
  hour12: false,
  timeZone: "Europe/Ljubljana",
});
const retryDelay = (attempts: number) =>
  Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6));

async function complete(
  ctx: MutationCtx,
  job: Doc<"pushJobs">,
  state: "sent" | "failed" | "expired",
  error?: string,
) {
  await ctx.db.patch(job._id, {
    state,
    error,
    leased: false,
    completedAt: Date.now(),
  });
}

async function retry(ctx: MutationCtx, job: Doc<"pushJobs">, error: string) {
  const now = Date.now();
  if (
    (job.state === "pending" && now >= job.expiresAt) ||
    (job.state === "receipt" &&
      now >= (job.ticketAt ?? job._creationTime) + 86400000)
  ) {
    await complete(ctx, job, "expired", error);
    return;
  }
  const delay = retryDelay(job.attempts);
  await ctx.db.patch(job._id, {
    leased: false,
    nextAttempt: now + delay,
    error,
  });
  await ctx.scheduler.runAfter(delay, internal.push.dispatch, {
    jobIds: [job._id],
  });
}

export const dispatch = internalMutation({
  args: ids,
  handler: async (ctx, args) => {
    const now = Date.now();
    const pending: { jobId: Id<"pushJobs">; attempt: number }[] = [];
    const receipts: { jobId: Id<"pushJobs">; attempt: number }[] = [];
    for (const jobId of args.jobIds) {
      const job = await ctx.db.get(jobId);
      if (
        !job ||
        job.leased ||
        (job.state !== "pending" && job.state !== "receipt")
      )
        continue;
      if (job.nextAttempt > now) {
        await ctx.scheduler.runAfter(
          job.nextAttempt - now,
          internal.push.dispatch,
          { jobIds: [jobId] },
        );
        continue;
      }
      if (
        (job.state === "pending" && job.expiresAt <= now) ||
        (job.state === "receipt" &&
          (job.ticketAt ?? job._creationTime) + 86400000 <= now)
      ) {
        await complete(ctx, job, "expired", "Alert or receipt expired");
        continue;
      }
      const device = await ctx.db.get(job.deviceId);
      if (
        job.state === "pending" &&
        (!device?.approved ||
          device.expoPushToken !== job.expoPushToken ||
          device.tokenVersion !== job.tokenVersion)
      ) {
        await complete(
          ctx,
          job,
          "failed",
          "Device approval or push token changed",
        );
        continue;
      }
      await ctx.db.patch(jobId, { leased: true, attempts: job.attempts + 1 });
      (job.state === "pending" ? pending : receipts).push({
        jobId,
        attempt: job.attempts + 1,
      });
      await ctx.scheduler.runAfter(30000, internal.push.recover, {
        jobId,
        attempt: job.attempts + 1,
      });
    }
    for (const jobs of [pending, receipts]) {
      if (jobs.length)
        await ctx.scheduler.runAfter(0, internal.push.deliver, { jobs });
    }
  },
});

export const recover = internalMutation({
  args: { jobId: v.id("pushJobs"), attempt: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job?.leased && job.attempts === args.attempt)
      await retry(ctx, job, "Push action did not finish");
  },
});

export const transportJobs = internalQuery({
  args: claims,
  handler: async (ctx, args) => {
    const result: TransportJob[] = [];
    for (const claim of args.jobs) {
      const job = await ctx.db.get(claim.jobId);
      if (
        !job?.leased ||
        job.attempts !== claim.attempt ||
        (job.state !== "pending" && job.state !== "receipt")
      )
        continue;
      const device = await ctx.db.get(job.deviceId);
      const message = await ctx.db.get(job.messageId);
      if (!message) continue;
      const authorized =
        !!device?.approved &&
        device.expoPushToken === job.expoPushToken &&
        device.tokenVersion === job.tokenVersion;
      result.push({ ...job, message, authorized });
    }
    return result;
  },
});

const outcome = v.object({
  jobId: v.id("pushJobs"),
  attempt: v.number(),
  status: v.union(
    v.literal("ticket"),
    v.literal("sent"),
    v.literal("failed"),
    v.literal("retry"),
  ),
  error: v.optional(v.string()),
  ticketId: v.optional(v.string()),
  ticketAt: v.optional(v.number()),
  resend: v.optional(v.boolean()),
});

export const finish = internalMutation({
  args: { outcomes: v.array(outcome) },
  handler: async (ctx, args) => {
    for (const result of args.outcomes) {
      const job = await ctx.db.get(result.jobId);
      if (!job?.leased || job.attempts !== result.attempt) continue;
      if (
        result.status === "ticket" &&
        result.ticketId &&
        result.ticketAt !== undefined
      ) {
        const nextAttempt = result.ticketAt + 15 * 60000;
        await ctx.db.patch(job._id, {
          state: "receipt",
          leased: false,
          nextAttempt,
          ticketId: result.ticketId,
          ticketAt: result.ticketAt,
          error: undefined,
        });
        await ctx.scheduler.runAfter(
          Math.max(0, nextAttempt - Date.now()),
          internal.push.dispatch,
          { jobIds: [job._id] },
        );
      } else if (result.status === "retry") {
        const device = await ctx.db.get(job.deviceId);
        if (
          result.resend &&
          (!device?.approved ||
            device.expoPushToken !== job.expoPushToken ||
            device.tokenVersion !== job.tokenVersion)
        ) {
          await complete(
            ctx,
            job,
            "failed",
            "Device approval or push token changed",
          );
        } else if (job.state === "receipt" && result.resend) {
          const pending = {
            ...job,
            state: "pending" as const,
            ticketId: undefined,
            ticketAt: undefined,
          };
          await ctx.db.patch(job._id, {
            state: "pending",
            ticketId: undefined,
            ticketAt: undefined,
          });
          await retry(ctx, pending, result.error ?? "Expo notification error");
        } else await retry(ctx, job, result.error ?? "Push request failed");
      } else {
        await complete(
          ctx,
          job,
          result.status === "sent" ? "sent" : "failed",
          result.error,
        );
        if (result.error === "DeviceNotRegistered") {
          const device = await ctx.db.get(job.deviceId);
          if (
            device?.expoPushToken === job.expoPushToken &&
            device.tokenVersion === job.tokenVersion
          ) {
            await ctx.db.patch(device._id, {
              expoPushToken: undefined,
              tokenVersion: device.tokenVersion + 1,
            });
          }
        }
      }
    }
  },
});

interface ExpoResult {
  status?: string;
  id?: string;
  details?: { error?: string };
}

interface ExpoPayload {
  data?: ExpoResult[] | Record<string, ExpoResult>;
  errors?: object[];
}

async function post(
  endpoint: string,
  body: object,
): Promise<ExpoPayload["data"]> {
  const token = process.env.EXPO_ACCESS_TOKEN;
  const response = await fetch(`https://exp.host/--/api/v2/push/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Expo HTTP ${response.status}`);
  const payload = (await response.json()) as ExpoPayload;
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.errors ||
    !payload.data
  )
    throw new Error("Invalid Expo response");
  return payload.data;
}

export const deliver = internalAction({
  args: claims,
  handler: async (ctx, args) => {
    const jobs: TransportJob[] = await ctx.runQuery(
      internal.push.transportJobs,
      args,
    );
    if (!jobs.length) return;
    const sentAt = Date.now();
    const receipts = jobs[0]!.state === "receipt";
    const ready = jobs.filter((job) =>
      receipts
        ? (job.ticketAt ?? job._creationTime) + 86400000 > sentAt
        : job.authorized && job.expiresAt > sentAt,
    );
    const outcomes: {
      jobId: Id<"pushJobs">;
      attempt: number;
      status: "ticket" | "sent" | "failed" | "retry";
      error?: string;
      ticketId?: string;
      ticketAt?: number;
      resend?: boolean;
    }[] = jobs
      .filter((job) => !ready.includes(job))
      .map((job) => ({
        jobId: job._id,
        attempt: job.attempts,
        status: "failed",
        error: "Device approval changed or alert expired",
      }));
    if (ready.length) {
      try {
        const data = receipts
          ? await post("getReceipts", { ids: ready.map((job) => job.ticketId) })
          : await post(
              "send",
              ready.map((job) => ({
                to: job.expoPushToken,
                title: `${String(job.message.ric).padStart(7, "0")} · ${receivedAtFormatter.format(new Date(job.message.receivedAt))}`,
                body: job.message.content,
                data: { messageId: job.message._id },
                sound: "default",
                priority: "high",
                channelId: "pager-alerts",
                ttl: Math.max(1, Math.ceil((job.expiresAt - sentAt) / 1000)),
              })),
            );
        if (
          receipts
            ? !data || Array.isArray(data) || typeof data !== "object"
            : !Array.isArray(data) || data.length !== ready.length
        )
          throw new Error("Invalid Expo ticket or receipt response");
        for (const [index, job] of ready.entries()) {
          const result = Array.isArray(data)
            ? data[index]
            : data?.[job.ticketId!];
          const base = { jobId: job._id, attempt: job.attempts };
          if (result?.status === "ok" && receipts)
            outcomes.push({ ...base, status: "sent" });
          else if (
            result?.status === "ok" &&
            typeof result.id === "string" &&
            result.id.trim().length > 0
          )
            outcomes.push({
              ...base,
              status: "ticket",
              ticketId: result.id,
              ticketAt: sentAt,
            });
          else if (result?.status === "error") {
            const providerError = result.details?.error;
            const error =
              typeof providerError === "string" &&
              [
                "DeviceNotRegistered",
                "MessageTooBig",
                "InvalidCredentials",
                "MismatchSenderId",
                "MessageRateExceeded",
              ].includes(providerError)
                ? providerError
                : "Expo notification error";
            const terminal = [
              "DeviceNotRegistered",
              "MessageTooBig",
              "InvalidCredentials",
              "MismatchSenderId",
            ].includes(error);
            outcomes.push({
              ...base,
              status: terminal ? "failed" : "retry",
              error,
              resend: !terminal,
            });
          } else
            outcomes.push({
              ...base,
              status: "retry",
              error: receipts
                ? "Push receipt not available"
                : "Invalid Expo ticket",
            });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Push request failed";
        for (const job of ready)
          outcomes.push({
            jobId: job._id,
            attempt: job.attempts,
            status: "retry",
            error: message,
          });
      }
    }
    await ctx.runMutation(internal.push.finish, { outcomes });
  },
});

export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db
      .query("pushJobs")
      .withIndex("by_completed", (q) =>
        q.gt("completedAt", 0).lt("completedAt", Date.now() - 7 * 86400000),
      )
      .take(100);
    for (const job of jobs) await ctx.db.delete(job._id);
    if (jobs.length === 100)
      await ctx.scheduler.runAfter(0, internal.push.cleanup, {});
  },
});

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  messageValidator,
  unitValidator,
  type PagerMessage,
} from "./validators";

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_INPUT", message });
}

function normalizeContent(content: string) {
  return (
    content
      .replace(/<CR><LF>|<(?:CR|LF)>|\r\n?|\n/g, " ")
      // POCSAG payloads may end in rendered terminators or EOT/NUL bytes.
      // oxlint-disable-next-line no-control-regex
      .replace(/(?:<(?:EOT|NUL)>|[\x00\x04])+$/, "")
  );
}

function checkMessage(message: PagerMessage) {
  if (
    !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|legacy:[1-9][0-9]*)$/i.test(
      message.sourceId,
    ) ||
    !Number.isFinite(Date.parse(message.receivedAt)) ||
    !Number.isInteger(message.ric) ||
    message.ric < 0 ||
    message.ric > 2097151 ||
    !Number.isInteger(message.function) ||
    message.function < 0 ||
    message.function > 3
  ) {
    invalid("Invalid pager message");
  }
}

export const ingest = internalMutation({
  args: { messages: v.array(messageValidator), notify: v.boolean() },
  handler: async (ctx, args) => {
    if (args.messages.length > 100) invalid("At most 100 messages per batch");
    const now = Date.now();
    const maxAge = Number(process.env.PUSH_MAX_AGE_SECONDS ?? 300);
    if (!Number.isFinite(maxAge) || maxAge <= 0)
      throw new Error("Invalid push max age configuration");
    const dedupeSeconds = Number(process.env.DEDUPE_SECONDS ?? 30);
    if (!Number.isFinite(dedupeSeconds) || dedupeSeconds < 0)
      throw new Error("Invalid dedupe configuration");
    const devices = args.notify ? await ctx.db.query("devices").collect() : [];
    let inserted = 0;
    for (const raw of args.messages) {
      checkMessage(raw);
      const message = {
        ...raw,
        receivedAt: new Date(raw.receivedAt).toISOString(),
        content: normalizeContent(raw.content),
      };
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_source", (q) => q.eq("sourceId", message.sourceId))
        .unique();
      if (existing) {
        if (
          existing.receivedAt !== message.receivedAt ||
          existing.ric !== message.ric ||
          existing.function !== message.function ||
          existing.type !== message.type ||
          normalizeContent(existing.content) !== message.content
        ) {
          invalid(
            `Source ID ${message.sourceId} already has different content`,
          );
        }
        continue;
      }
      const source =
        dedupeSeconds > 0
          ? await ctx.db
              .query("messages")
              .withIndex("by_call", (q) =>
                q
                  .eq("ric", message.ric)
                  .eq("function", message.function)
                  .eq("type", message.type)
                  .eq("content", message.content)
                  .gte(
                    "receivedAt",
                    new Date(
                      Date.parse(message.receivedAt) - dedupeSeconds * 1000,
                    ).toISOString(),
                  )
                  .lte("receivedAt", message.receivedAt),
              )
              .filter((q) => q.eq(q.field("duplicateOf"), null))
              .order("desc")
              .first()
          : null;
      const duplicateOf = source?._id ?? null;
      const needsLocation =
        duplicateOf === null &&
        message.type !== "tone" &&
        message.content.trim().length !== 0 &&
        args.notify;
      const messageId = await ctx.db.insert("messages", {
        ...message,
        duplicateOf,
        ...(source?.location !== undefined
          ? { location: source.location }
          : {}),
        ...(needsLocation
          ? {
              enrichment: {
                state: "pending" as const,
                attempt: 0,
                nextAttempt: now,
              },
            }
          : {}),
      });
      inserted++;
      if (needsLocation)
        await ctx.scheduler.runAfter(0, internal.location.dispatch, {
          messageId,
        });
      const expiresAt = Date.parse(message.receivedAt) + maxAge * 1000;
      if (duplicateOf !== null || expiresAt <= now) continue;
      const jobIds: Id<"pushJobs">[] = [];
      for (const device of devices) {
        if (!device.approved || !device.expoPushToken) continue;
        const jobId = await ctx.db.insert("pushJobs", {
          deviceId: device._id,
          messageId,
          expoPushToken: device.expoPushToken,
          tokenVersion: device.tokenVersion,
          expiresAt,
          state: "pending",
          nextAttempt: now,
          attempts: 0,
          leased: false,
        });
        jobIds.push(jobId);
      }
      for (let start = 0; start < jobIds.length; start += 100) {
        await ctx.scheduler.runAfter(0, internal.push.dispatch, {
          jobIds: jobIds.slice(start, start + 100),
        });
      }
    }
    return { inserted };
  },
});

export const ricUnits = internalMutation({
  args: { units: v.array(unitValidator) },
  handler: async (ctx, args) => {
    const rics = new Set<number>();
    for (const unit of args.units) {
      if (
        !Number.isInteger(unit.ric) ||
        unit.ric < 0 ||
        unit.ric > 2097151 ||
        !unit.unitName.trim() ||
        rics.has(unit.ric)
      )
        invalid("Invalid or duplicate RIC unit");
      rics.add(unit.ric);
    }
    const existing = await ctx.db.query("ricUnits").collect();
    for (const unit of existing)
      if (!rics.has(unit.ric)) await ctx.db.delete(unit._id);
    for (const unit of args.units) {
      const row = existing.find((entry) => entry.ric === unit.ric);
      if (!row) await ctx.db.insert("ricUnits", unit);
      else if (row.unitName !== unit.unitName)
        await ctx.db.patch(row._id, { unitName: unit.unitName });
    }
    return { updated: args.units.length };
  },
});

export const devices = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("devices").collect()).map((device) => ({
      uid: device.userId,
      approved: device.approved,
      expoPushToken: device.expoPushToken ?? null,
    })),
});

export const members = internalMutation({
  args: { uid: v.string(), approved: v.boolean() },
  handler: async (ctx, args) => {
    const userId = ctx.db.normalizeId("users", args.uid);
    if (!userId || !(await ctx.db.get(userId))) invalid("Unknown Convex user");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (device) await ctx.db.patch(device._id, { approved: args.approved });
    else
      await ctx.db.insert("devices", {
        userId,
        approved: args.approved,
        tokenVersion: 0,
      });
    return { uid: userId, approved: args.approved };
  },
});

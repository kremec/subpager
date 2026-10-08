import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import {
  messageValidator,
  unitValidator,
  type PagerMessage,
} from "./validators";

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_INPUT", message });
}

function checkLocation(content: string, location: string | null) {
  if (
    location !== null &&
    (!location.trim() ||
      location !== location.trim() ||
      !content.includes(location))
  ) {
    invalid("Location must be an exact message substring");
  }
}

function checkMessage(message: PagerMessage) {
  if (
    !Number.isSafeInteger(message.id) ||
    message.id < 1 ||
    !Number.isFinite(Date.parse(message.receivedAt)) ||
    !Number.isInteger(message.ric) ||
    message.ric < 0 ||
    message.ric > 2097151 ||
    !Number.isInteger(message.function) ||
    message.function < 0 ||
    message.function > 3 ||
    (message.duplicateOf !== null &&
      (!Number.isSafeInteger(message.duplicateOf) || message.duplicateOf < 1))
  ) {
    invalid("Invalid pager message");
  }
  if (message.location !== undefined)
    checkLocation(message.content, message.location);
}

async function findMessage(ctx: MutationCtx, receiverId: number) {
  const mapping = await ctx.db
    .query("receiverMessages")
    .withIndex("by_receiverId", (q) => q.eq("receiverId", receiverId))
    .unique();
  if (mapping) {
    const message = await ctx.db.get(mapping.messageId);
    if (!message)
      throw new Error("Receiver message mapping points to a missing message");
    return message;
  }
  return null;
}

export const ingest = internalMutation({
  args: { messages: v.array(messageValidator), notify: v.boolean() },
  handler: async (ctx, args) => {
    if (args.messages.length > 100) invalid("At most 100 messages per batch");
    const now = Date.now();
    const maxAge = Number(process.env.PUSH_MAX_AGE_SECONDS ?? 300);
    if (!Number.isFinite(maxAge) || maxAge <= 0)
      throw new Error("Invalid push max age configuration");
    const devices = args.notify ? await ctx.db.query("devices").collect() : [];
    let inserted = 0;
    for (const message of args.messages) {
      checkMessage(message);
      const {
        id: receiverId,
        duplicateOf: receiverDuplicateOf,
        ...content
      } = message;
      const source =
        receiverDuplicateOf === null
          ? null
          : await findMessage(ctx, receiverDuplicateOf);
      if (receiverDuplicateOf !== null && !source)
        invalid("Ingest the duplicate source before its repeated message");
      const duplicateOf = source?._id ?? null;
      const existing = await findMessage(ctx, receiverId);
      if (existing) {
        if (
          existing.receivedAt !== message.receivedAt ||
          existing.ric !== message.ric ||
          existing.function !== message.function ||
          existing.type !== message.type ||
          existing.content !== message.content ||
          existing.duplicateOf !== duplicateOf
        ) {
          invalid(`Message ID ${message.id} already has different content`);
        }
        if (existing.location === undefined && message.location !== undefined)
          await ctx.db.patch(existing._id, { location: message.location });
        continue;
      }
      const messageId = await ctx.db.insert("messages", {
        ...content,
        duplicateOf,
      });
      await ctx.db.insert("receiverMessages", { receiverId, messageId });
      inserted++;
      const expiresAt = Date.parse(message.receivedAt) + maxAge * 1000;
      if (message.duplicateOf !== null || expiresAt <= now) continue;
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

export const location = internalMutation({
  args: { id: v.number(), location: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const message = await findMessage(ctx, args.id);
    if (!message)
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Message not found",
      });
    checkLocation(message.content, args.location);
    await ctx.db.patch(message._id, { location: args.location });
    return { updated: true };
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

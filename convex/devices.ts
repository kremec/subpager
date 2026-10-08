import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

import { mutation, query, type QueryCtx } from "./_generated/server";

export async function requireApproved(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Authentication required");
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!device?.approved) throw new ConvexError("Device approval required");
  return device;
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return { uid: userId, approved: device?.approved ?? false };
  },
});

export const register = mutation({
  args: { expoPushToken: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Authentication required");
    if (
      args.expoPushToken != null &&
      !/^(ExponentPushToken|ExpoPushToken)\[[^\]\s]+\]$/.test(
        args.expoPushToken,
      )
    ) {
      throw new ConvexError("Invalid Expo push token");
    }
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!device) {
      await ctx.db.insert("devices", {
        userId,
        approved: false,
        tokenVersion: 0,
        ...(args.expoPushToken ? { expoPushToken: args.expoPushToken } : {}),
      });
    } else if (
      args.expoPushToken !== undefined &&
      (args.expoPushToken ?? undefined) !== device.expoPushToken
    ) {
      await ctx.db.patch(device._id, {
        expoPushToken: args.expoPushToken ?? undefined,
        tokenVersion: device.tokenVersion + 1,
      });
    }
    return { uid: userId, approved: device?.approved ?? false };
  },
});

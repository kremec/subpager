import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { messageFields, pushState } from "./validators";

export default defineSchema({
  ...authTables,
  devices: defineTable({
    userId: v.id("users"),
    approved: v.boolean(),
    expoPushToken: v.optional(v.string()),
    tokenVersion: v.number(),
  }).index("by_user", ["userId"]),
  messages: defineTable({
    ...messageFields,
    sourceId: v.string(),
    enrichment: v.optional(
      v.object({
        state: v.union(
          v.literal("pending"),
          v.literal("running"),
          v.literal("failed"),
        ),
        attempt: v.number(),
        failures: v.optional(v.number()),
        nextAttempt: v.number(),
        error: v.optional(v.string()),
      }),
    ),
  })
    .index("by_received_at", ["receivedAt"])
    .index("by_source", ["sourceId"])
    .index("by_call", ["ric", "function", "type", "content", "receivedAt"])
    .index("by_duplicate", ["duplicateOf"]),
  ricUnits: defineTable({ ric: v.number(), unitName: v.string() }).index(
    "by_ric",
    ["ric"],
  ),
  pushJobs: defineTable({
    deviceId: v.id("devices"),
    messageId: v.id("messages"),
    expoPushToken: v.string(),
    tokenVersion: v.number(),
    expiresAt: v.number(),
    state: pushState,
    nextAttempt: v.number(),
    attempts: v.number(),
    leased: v.boolean(),
    ticketId: v.optional(v.string()),
    ticketAt: v.optional(v.number()),
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  }).index("by_completed", ["completedAt"]),
});

import { v, type Infer } from "convex/values";

export const messageFields = {
  receivedAt: v.string(),
  ric: v.number(),
  function: v.number(),
  type: v.union(v.literal("alpha"), v.literal("numeric"), v.literal("tone")),
  content: v.string(),
  duplicateOf: v.union(v.id("messages"), v.null()),
  location: v.optional(v.union(v.string(), v.null())),
};

export const messageValidator = v.object({
  ...messageFields,
  id: v.number(),
  duplicateOf: v.union(v.number(), v.null()),
});
export type PagerMessage = Infer<typeof messageValidator>;
export const unitValidator = v.object({
  ric: v.number(),
  unitName: v.string(),
});
export const pushState = v.union(
  v.literal("pending"),
  v.literal("receipt"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("expired"),
);

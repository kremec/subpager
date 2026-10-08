import { query } from "./_generated/server";
import { requireApproved } from "./devices";

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireApproved(ctx);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_received_at")
      .order("desc")
      .collect();
    return messages.map((document) => {
      const {
        _id,
        _creationTime,
        sourceId: _sourceId,
        enrichment: _enrichment,
        ...message
      } = document;
      return { ...message, id: _id };
    });
  },
});

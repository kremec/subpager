import { query } from "./_generated/server";
import { requireApproved } from "./devices";

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireApproved(ctx);
    const units = await ctx.db.query("ricUnits").withIndex("by_ric").collect();
    return units.map(({ ric, unitName }) => ({ ric, unitName }));
  },
});

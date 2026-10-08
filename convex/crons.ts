import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();
crons.daily(
  "Remove completed push jobs",
  { hourUTC: 3, minuteUTC: 0 },
  internal.push.cleanup,
  {},
);
export default crons;

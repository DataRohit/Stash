import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep stale presence", { minutes: 1 }, internal.presence.sweepStale, {});

export default crons;

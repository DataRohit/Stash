import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep stale presence", { minutes: 1 }, internal.presence.sweepStale, {});
crons.interval("prune document history", { hours: 1 }, internal.collab.pruneHistory, {});
crons.interval("resume project purges", { minutes: 10 }, internal.projects.resumePurges, {});
crons.interval("resume document purges", { minutes: 10 }, internal.documents.resumePurges, {});

export default crons;

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep stale presence", { minutes: 1 }, internal.presence.sweepStale, {});
crons.interval("prune document history", { hours: 1 }, internal.collab.pruneHistory, {});
crons.interval("resume project purges", { minutes: 10 }, internal.projects.resumePurges, {});
crons.interval("resume document purges", { minutes: 10 }, internal.documents.resumePurges, {});
crons.interval("purge expired trash", { hours: 6 }, internal.documents.purgeExpiredTrash, {});
crons.interval("prune old notifications", { hours: 6 }, internal.comments.pruneNotifications, {});
crons.interval("prune old share events", { hours: 12 }, internal.sharing.pruneShareEvents, {});
crons.interval("prune project activity", { hours: 12 }, internal.activity.pruneProjectEvents, {});
crons.interval("reap stuck project clones", { minutes: 30 }, internal.projects.reapStuckClones, {});

export default crons;

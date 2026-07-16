import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep stale presence", { minutes: 1 }, internal.presence.sweepStale, {});
crons.interval("prune document history", { hours: 1 }, internal.collab.pruneHistory, {});
crons.interval(
  "backfill document tree projections",
  { minutes: 10 },
  internal.documents.scheduleDocumentNodeBackfill,
  {},
);
crons.interval("resume project purges", { minutes: 10 }, internal.projects.resumePurges, {});
crons.interval("resume document purges", { minutes: 10 }, internal.documents.resumePurges, {});
crons.interval("purge expired trash", { hours: 6 }, internal.documents.purgeExpiredTrash, {});
crons.interval("prune old notifications", { hours: 6 }, internal.comments.pruneNotifications, {});
crons.interval("prune old share events", { hours: 12 }, internal.sharing.pruneShareEvents, {});
crons.interval("prune share rate windows", { minutes: 30 }, internal.sharing.pruneShareWindows, {});
crons.interval(
  "prune authenticated write windows",
  { minutes: 30 },
  internal.writeRateLimit.pruneWriteWindows,
  {},
);
crons.interval("prune project activity", { hours: 12 }, internal.activity.pruneProjectEvents, {});
crons.interval("reap stuck project clones", { minutes: 30 }, internal.projects.reapStuckClones, {});
crons.daily(
  "reconcile project bytes",
  { hourUTC: 2, minuteUTC: 0 },
  internal.maintenance.walkProjectBytes,
  {},
);
crons.weekly(
  "sweep orphan storage",
  { dayOfWeek: "sunday", hourUTC: 3, minuteUTC: 0 },
  internal.maintenance.sweepOrphanStorage,
  { dryRun: false },
);
crons.daily(
  "prune recent documents",
  { hourUTC: 4, minuteUTC: 0 },
  internal.navigation.pruneRecentDocuments,
  {},
);

export default crons;

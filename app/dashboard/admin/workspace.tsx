"use client";

import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  Copy,
  Download,
  HardDrive,
  KeyRound,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { DataLoader } from "@/components/ui/data-state";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatBytes, formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OrganizationExport } from "./organization-export";
import { WebhookManager } from "./webhook-manager";

type Tab = "audit" | "usage" | "trust";

export function AdminWorkspace({ clerkOrgId }: { clerkOrgId: string }) {
  const [tab, setTab] = useState<Tab>("audit");
  const [auditKind, setAuditKind] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [auditActor, setAuditActor] = useState("");
  const [auditProject, setAuditProject] = useState("");
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditHistory, setAuditHistory] = useState<Array<string | null>>([]);
  const events = useQuery(api.audit.list, {
    clerkOrgId,
    limit: 100,
    cursor: auditCursor,
    kind: auditKind || undefined,
    actorUserId: auditActor || undefined,
    projectId: auditProject ? (auditProject as Id<"projects">) : undefined,
    from: auditFrom ? new Date(`${auditFrom}T00:00:00`).getTime() : undefined,
    to: auditTo ? new Date(`${auditTo}T23:59:59.999`).getTime() : undefined,
  });
  const usage = useQuery(api.audit.usage, { clerkOrgId });
  const filterOptions = useQuery(api.audit.filterOptions, { clerkOrgId });
  const apiKeys = useQuery(api.apiKeys.list, { clerkOrgId });
  const createApiKey = useMutation(api.apiKeys.create);
  const revokeApiKey = useMutation(api.apiKeys.revoke);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyScopes, setKeyScopes] = useState(["projects:read", "documents:read"]);
  const auditExportHref = `/api/audit/export?${new URLSearchParams({
    ...(auditKind ? { kind: auditKind } : {}),
    ...(auditActor ? { actor: auditActor } : {}),
    ...(auditProject ? { project: auditProject } : {}),
    ...(auditFrom ? { from: String(new Date(`${auditFrom}T00:00:00`).getTime()) } : {}),
    ...(auditTo ? { to: String(new Date(`${auditTo}T23:59:59.999`).getTime()) } : {}),
  })}`;

  return (
    <main className="flex w-full flex-col items-center px-3 pt-32 pb-16 sm:px-6 lg:pt-28">
      <div className="flex w-full max-w-7xl flex-col gap-6">
        <section className="glass rounded-lg p-5 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <span className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
                — Administration
              </span>
              <h1 className="mt-1 font-serif text-3xl tracking-display">Trust center</h1>
              <p className="mt-2 max-w-2xl text-muted-foreground text-sm">
                Review organization activity, capacity, access posture, and retention policy.
              </p>
            </div>
            {tab === "audit" ? (
              <a
                href={auditExportHref}
                aria-disabled={!events?.items.length}
                className={cn(
                  buttonVariants({ variant: "secondary" }),
                  !events?.items.length && "pointer-events-none opacity-50",
                )}
              >
                <Download className="size-4" aria-hidden="true" />
                Export CSV
              </a>
            ) : null}
          </div>
          <div className="mt-6 flex overflow-x-auto rounded-sm border border-hairline p-1">
            {(["audit", "usage", "trust"] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={tab === item}
                onClick={() => setTab(item)}
                className={cn(
                  "h-10 min-w-28 flex-1 cursor-pointer rounded-xs px-4 font-medium text-sm capitalize transition-colors",
                  tab === item
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item}
              </button>
            ))}
          </div>
        </section>

        {tab === "audit" ? (
          <section className="glass overflow-hidden rounded-lg">
            <div className="grid gap-3 border-hairline border-b p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-5">
              <label className="grid gap-1 text-muted-foreground text-xs">
                Event kind
                <input
                  value={auditKind}
                  onChange={(event) => {
                    setAuditKind(event.target.value);
                    setAuditCursor(null);
                    setAuditHistory([]);
                  }}
                  placeholder="For example, member.joined"
                  className="h-11 rounded-sm border border-hairline bg-background px-3 text-foreground text-sm outline-none focus:border-accent"
                />
              </label>
              <label className="grid gap-1 text-muted-foreground text-xs">
                Actor
                <input
                  list="audit-actors"
                  placeholder="All actors"
                  onChange={(event) => {
                    const match = filterOptions?.actors.find(
                      (actor) => actor.name === event.target.value,
                    );
                    setAuditActor(match?.id ?? "");
                    setAuditCursor(null);
                    setAuditHistory([]);
                  }}
                  className="h-11 rounded-sm border border-hairline bg-background px-3 text-foreground text-sm outline-none focus:border-accent"
                />
                <datalist id="audit-actors">
                  {filterOptions?.actors.map((actor) => (
                    <option key={actor.id} value={actor.name} />
                  ))}
                </datalist>
              </label>
              <label className="grid gap-1 text-muted-foreground text-xs">
                Project
                <input
                  list="audit-projects"
                  placeholder="All projects"
                  onChange={(event) => {
                    const match = filterOptions?.projects.find(
                      (project) => project.name === event.target.value,
                    );
                    setAuditProject(match?.id ?? "");
                    setAuditCursor(null);
                    setAuditHistory([]);
                  }}
                  className="h-11 rounded-sm border border-hairline bg-background px-3 text-foreground text-sm outline-none focus:border-accent"
                />
                <datalist id="audit-projects">
                  {filterOptions?.projects.map((project) => (
                    <option key={project.id} value={project.name} />
                  ))}
                </datalist>
              </label>
              <label className="grid gap-1 text-muted-foreground text-xs">
                From
                <input
                  type="date"
                  value={auditFrom}
                  onChange={(event) => {
                    setAuditFrom(event.target.value);
                    setAuditCursor(null);
                    setAuditHistory([]);
                  }}
                  className="h-11 rounded-sm border border-hairline bg-background px-3 text-foreground text-sm"
                />
              </label>
              <label className="grid gap-1 text-muted-foreground text-xs">
                Through
                <input
                  type="date"
                  value={auditTo}
                  onChange={(event) => {
                    setAuditTo(event.target.value);
                    setAuditCursor(null);
                    setAuditHistory([]);
                  }}
                  className="h-11 rounded-sm border border-hairline bg-background px-3 text-foreground text-sm"
                />
              </label>
            </div>
            {!events ? (
              <DataLoader label="Loading audit events" />
            ) : events.items.length === 0 ? (
              <div className="p-10 text-center">
                <Activity className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
                <h2 className="mt-3 font-serif text-xl">No recorded events yet</h2>
                <p className="mt-1 text-muted-foreground text-sm">
                  Membership, guest, share, API, and export activity will appear here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-hairline">
                {events.items.map((event) => (
                  <li key={event.id} className="grid gap-2 p-4 sm:grid-cols-[1fr_1fr_auto] sm:p-5">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-sm">{event.actorName}</p>
                      <p className="truncate text-muted-foreground text-xs">
                        {event.projectName ?? "Organization"}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="font-mono text-xs uppercase tracking-wider">{event.kind}</p>
                      <p className="truncate text-muted-foreground text-xs">{event.targetName}</p>
                    </div>
                    <time
                      dateTime={new Date(event.createdAt).toISOString()}
                      title={formatDateTime(event.createdAt)}
                      className="text-muted-foreground text-xs sm:text-right"
                      suppressHydrationWarning
                    >
                      {formatRelativeTime(event.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
            {events && (auditHistory.length > 0 || events.nextCursor) ? (
              <div className="flex justify-between gap-2 border-hairline border-t p-4">
                <Button
                  variant="secondary"
                  disabled={auditHistory.length === 0}
                  onClick={() => {
                    const previous = auditHistory.at(-1) ?? null;
                    setAuditHistory((history) => history.slice(0, -1));
                    setAuditCursor(previous);
                  }}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={!events.nextCursor}
                  onClick={() => {
                    setAuditHistory((history) => [...history, auditCursor]);
                    setAuditCursor(events.nextCursor);
                  }}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}

        {tab === "usage" ? (
          !usage ? (
            <section className="glass rounded-lg">
              <DataLoader label="Loading usage" />
            </section>
          ) : (
            <section className="grid gap-4 lg:grid-cols-3">
              {[
                {
                  label: "Seats",
                  value: `${usage.seats}`,
                  hint: `${usage.guests} guests`,
                  icon: Users,
                },
                {
                  label: "Projects",
                  value: `${usage.projectCount}`,
                  hint: `${usage.projectLimit} plan limit`,
                  icon: Activity,
                },
                {
                  label: "Storage",
                  value: formatBytes(usage.storageBytes),
                  hint: "Across active projects",
                  icon: HardDrive,
                },
              ].map(({ label, value, hint, icon: Icon }) => (
                <article key={label} className="glass rounded-lg p-5">
                  <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-5 font-mono text-3xl tabular-nums">{value}</p>
                  <p className="mt-1 font-medium text-sm">{label}</p>
                  <p className="text-muted-foreground text-xs">{hint}</p>
                </article>
              ))}
              <div className="glass overflow-hidden rounded-lg lg:col-span-3">
                <div className="border-hairline border-b p-5">
                  <h2 className="font-serif text-xl">Project usage</h2>
                </div>
                <ul className="divide-y divide-hairline">
                  {usage.projects.map((project) => (
                    <li
                      key={project.id}
                      className="grid gap-2 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:p-5"
                    >
                      <span className="truncate font-medium text-sm">{project.title}</span>
                      <span className="font-mono text-muted-foreground text-xs">
                        {formatBytes(project.storageBytes)} / {formatBytes(project.storageLimit)}
                      </span>
                      <span className="font-mono text-muted-foreground text-xs">
                        {project.activityCount} recent events
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )
        ) : null}

        {tab === "trust" ? (
          <section className="glass flex flex-col gap-8 rounded-lg p-5 sm:p-8">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-5 text-accent" aria-hidden="true" />
              <div>
                <h2 className="font-serif text-xl">Data lifecycle</h2>
                <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
                  Deleted documents remain recoverable for {usage?.trashRetentionDays ?? 30} days.
                  Version history is retained for {usage?.historyRetentionDays ?? 30} days under the
                  active plan. Public links can be disabled organization-wide and all high-privilege
                  actions are recorded in the audit trail.
                </p>
                <p className="mt-2 text-muted-foreground text-xs leading-relaxed">
                  Organization administrators can audit every project regardless of an individual
                  project grant. Enterprise SSO and automated provisioning are not enabled.
                </p>
              </div>
            </div>
            <div className="border-hairline border-t pt-6">
              <div className="flex items-start gap-3">
                <KeyRound className="mt-0.5 size-5 text-accent" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <h2 className="font-serif text-xl">API keys</h2>
                  <p className="mt-1 text-muted-foreground text-sm">
                    Keys are shown once, stored as hashes, scoped, rate-limited, and revocable.
                  </p>
                  {revealedKey ? (
                    <div className="mt-4 rounded-sm border border-warning/40 bg-warning/10 p-3">
                      <p className="text-xs">Copy this key now. It cannot be shown again.</p>
                      <div className="mt-2 flex gap-2">
                        <input
                          readOnly
                          value={revealedKey}
                          className="h-11 min-w-0 flex-1 rounded-sm border border-hairline bg-background px-3 font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void navigator.clipboard.writeText(revealedKey)}
                          aria-label="Copy API key"
                        >
                          <Copy className="size-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <form
                    className="mt-4 grid gap-2"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      setKeyBusy(true);
                      try {
                        const result = await createApiKey({
                          clerkOrgId,
                          name: newKeyName,
                          scopes: keyScopes,
                        });
                        setRevealedKey(result.key);
                        setNewKeyName("");
                      } finally {
                        setKeyBusy(false);
                      }
                    }}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        required
                        maxLength={80}
                        value={newKeyName}
                        onChange={(event) => setNewKeyName(event.target.value)}
                        placeholder="Automation key"
                        className="h-11 min-w-0 flex-1 rounded-sm border border-hairline bg-background px-3 text-sm outline-none focus:border-accent"
                      />
                      <Button
                        type="submit"
                        disabled={keyBusy || !newKeyName.trim() || keyScopes.length === 0}
                        className="h-11"
                      >
                        Create key
                      </Button>
                    </div>
                    <fieldset className="grid gap-1 sm:grid-cols-2">
                      <legend className="text-muted-foreground text-xs">Scopes</legend>
                      {(
                        [
                          ["projects:read", "List projects"],
                          ["documents:read", "Read documents"],
                          ["documents:write", "Create and append Markdown"],
                          ["properties:write", "Update document properties"],
                        ] as const
                      ).map(([scope, label]) => (
                        <label
                          key={scope}
                          className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xs px-2 text-sm hover:bg-foreground/[0.04]"
                        >
                          <input
                            type="checkbox"
                            checked={keyScopes.includes(scope)}
                            onChange={(event) =>
                              setKeyScopes(
                                event.target.checked
                                  ? [...keyScopes, scope]
                                  : keyScopes.filter((item) => item !== scope),
                              )
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                  </form>
                  <ul className="mt-4 divide-y divide-hairline">
                    {(apiKeys ?? []).map((key) => (
                      <li key={key.id} className="flex min-h-14 items-center gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-sm">{key.name}</p>
                          <p className="truncate font-mono text-muted-foreground text-xs">
                            {key.prefix}… · {key.scopes.join(", ")}
                          </p>
                        </div>
                        {key.revokedAt ? (
                          <span className="font-mono text-muted-foreground text-xs uppercase">
                            Revoked
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Revoke ${key.name}`}
                            onClick={() => void revokeApiKey({ clerkOrgId, keyId: key.id })}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
            <OrganizationExport clerkOrgId={clerkOrgId} />
            <WebhookManager clerkOrgId={clerkOrgId} />
          </section>
        ) : null}
      </div>
    </main>
  );
}

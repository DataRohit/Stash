"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { Copy, Loader2, Send, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

const EVENTS = [
  ["document.created", "Document created"],
  ["comment.created", "Comment added"],
  ["project_share.changed", "Project share changed"],
  ["member.joined", "Member joined"],
  ["member.left", "Member left"],
  ["guest.joined", "Guest joined"],
] as const;

export function WebhookManager({ clerkOrgId }: { clerkOrgId: string }) {
  const endpoints = useQuery(api.webhooks.list, { clerkOrgId });
  const createEndpoint = useAction(api.webhooks.create);
  const removeEndpoint = useMutation(api.webhooks.remove);
  const setDisabled = useMutation(api.webhooks.setDisabled);
  const queueTest = useMutation(api.webhooks.queueTest);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<string[]>(["document.created", "comment.created"]);
  const [signingSecret, setSigningSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="border-hairline border-t pt-6">
      <div className="flex items-start gap-3">
        <Webhook className="mt-0.5 size-5 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-xl">Outgoing webhooks</h2>
          <p className="mt-1 text-muted-foreground text-sm">
            Deliver signed, content-free event envelopes to an HTTPS endpoint. Slack integration is
            not enabled.
          </p>
          {signingSecret ? (
            <div className="mt-4 rounded-sm border border-warning/40 bg-warning/10 p-3">
              <p className="text-xs">Copy this signing secret now. It cannot be shown again.</p>
              <div className="mt-2 flex gap-2">
                <input
                  readOnly
                  value={signingSecret}
                  className="h-11 min-w-0 flex-1 rounded-sm border border-hairline bg-background px-3 font-mono text-xs"
                />
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Copy webhook secret"
                  onClick={() => void navigator.clipboard.writeText(signingSecret)}
                >
                  <Copy className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ) : null}
          <form
            className="mt-4 grid gap-3 rounded-sm border border-hairline p-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                const result = await createEndpoint({
                  clerkOrgId,
                  name,
                  url,
                  eventKinds: selected,
                });
                setSigningSecret(result.signingSecret);
                setName("");
                setUrl("");
                notify.success("Webhook endpoint created");
              } catch (error) {
                notify.error("Couldn’t create webhook", {
                  description:
                    error instanceof Error && error.message.includes("invalid-url")
                      ? "Use a public HTTPS URL without credentials or a custom port."
                      : "Check the endpoint and encryption configuration.",
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Deployment events"
                className="h-11 rounded-sm border border-hairline bg-background px-3 text-sm outline-none focus:border-accent"
              />
              <input
                required
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/stash-events"
                className="h-11 rounded-sm border border-hairline bg-background px-3 text-sm outline-none focus:border-accent"
              />
            </div>
            <fieldset className="grid gap-1 sm:grid-cols-2">
              <legend className="mb-1 text-muted-foreground text-xs">Events</legend>
              {EVENTS.map(([value, label]) => (
                <label
                  key={value}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xs px-2 text-sm hover:bg-foreground/[0.04]"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(value)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, value]
                          : selected.filter((item) => item !== value),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <Button
              type="submit"
              className="h-11 sm:justify-self-start"
              disabled={busy || !name.trim() || !url.trim() || selected.length === 0}
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Create endpoint
            </Button>
          </form>
          <ul className="mt-5 space-y-3">
            {(endpoints ?? []).map((endpoint) => (
              <li key={endpoint.id} className="rounded-sm border border-hairline p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{endpoint.name}</p>
                    <p className="truncate font-mono text-muted-foreground text-xs">
                      {endpoint.url}
                    </p>
                    <p className="mt-1 text-muted-foreground text-xs">
                      {endpoint.eventKinds.join(" · ")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void queueTest({ endpointId: endpoint.id })}
                      disabled={Boolean(endpoint.disabledAt)}
                    >
                      <Send className="size-3.5" aria-hidden="true" /> Test
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        void setDisabled({
                          endpointId: endpoint.id,
                          disabled: !endpoint.disabledAt,
                        })
                      }
                    >
                      {endpoint.disabledAt ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${endpoint.name}`}
                      onClick={() => void removeEndpoint({ endpointId: endpoint.id })}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {endpoint.disabledAt ? (
                  <p className="mt-2 text-warning text-xs">
                    Disabled after {endpoint.failureCount} consecutive failures.
                  </p>
                ) : null}
                {endpoint.deliveries.length > 0 ? (
                  <ul className="mt-3 divide-y divide-hairline border-hairline border-t">
                    {endpoint.deliveries.slice(0, 5).map((delivery) => (
                      <li
                        key={delivery.id}
                        className="flex min-h-10 items-center gap-2 py-2 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate">{delivery.eventKind}</span>
                        <span className="font-mono text-muted-foreground">
                          {delivery.responseStatus ?? delivery.state}
                        </span>
                        <time
                          dateTime={new Date(delivery.updatedAt).toISOString()}
                          title={formatDateTime(delivery.updatedAt)}
                          className="text-muted-foreground"
                          suppressHydrationWarning
                        >
                          {formatRelativeTime(delivery.updatedAt)}
                        </time>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

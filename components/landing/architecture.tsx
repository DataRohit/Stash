import { Panel } from "@/components/landing/panel";
import { Reveal } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";
import { SectionHeader } from "@/components/landing/section-header";
import { cn } from "@/lib/utils";

const layers = [
  {
    label: "Client",
    title: "Next.js + React",
    dot: "bg-signal",
    items: ["App Router & RSC", "Reactive subscriptions", "Optimistic local state"],
  },
  {
    label: "Backend",
    title: "Convex",
    dot: "bg-accent",
    items: ["Reactive database", "Type-safe functions", "Live queries & sync"],
  },
  {
    label: "Collaboration",
    title: "Documents",
    dot: "bg-destructive",
    items: ["Presence & co-editing", "Version history", "Shareable read-only links"],
  },
];

const primitives = [
  "Documents",
  "Folders",
  "Projects",
  "Organizations",
  "Invites",
  "Versions",
  "Links",
];

export function Architecture() {
  return (
    <Section id="architecture">
      <Reveal>
        <SectionHeader
          kicker="Architecture"
          title="A reactive stack, end to end."
          description="The client subscribes to a reactive backend, so every edit propagates to collaborators without manual refetching."
        />
      </Reveal>

      <Panel label="Reactive stack" meta="03 layers" className="mt-12">
        <div className="grid grid-cols-1 md:grid-cols-3">
          {layers.map((layer, index) => (
            <div
              key={layer.label}
              className={cn(
                "p-6 transition-colors duration-200 hover:bg-foreground/[0.035]",
                index > 0 && "border-hairline border-t md:border-t-0 md:border-l",
              )}
            >
              <div className="flex items-center justify-between gap-4">
                <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
                  {layer.label}
                </span>
                <span className={cn("size-1.5 shrink-0", layer.dot)} aria-hidden="true" />
              </div>
              <h3 className="mt-4 font-semibold text-lg tracking-display">{layer.title}</h3>
              <ul className="mt-5 flex flex-col gap-3">
                {layer.items.map((item) => (
                  <li key={item} className="flex items-center gap-3 text-muted-foreground text-sm">
                    <span className="h-px w-5 shrink-0 bg-hairline" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-hairline border-t bg-foreground/[0.018] px-5 py-4 sm:px-6">
          <div className="mb-3 flex items-center justify-between gap-4">
            <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
              Data primitives
            </span>
            <span className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
              {String(primitives.length).padStart(2, "0")} models
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {primitives.map((primitive) => (
              <span
                key={primitive}
                className="press-shadow hairline flex-1 whitespace-nowrap rounded-[6px] bg-surface/45 px-4 py-3 text-center font-mono text-muted-foreground text-xs uppercase tracking-wider backdrop-blur"
              >
                {primitive}
              </span>
            ))}
          </div>
        </div>
      </Panel>
    </Section>
  );
}

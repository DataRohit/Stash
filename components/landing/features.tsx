import { Building2, FileText, FolderTree, History, Share2, Users } from "lucide-react";
import { Panel } from "@/components/landing/panel";
import { Reveal } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";
import { SectionHeader } from "@/components/landing/section-header";
import { cn } from "@/lib/utils";

const features = [
  {
    icon: FileText,
    category: "Authoring",
    title: "Documents & structured data",
    description:
      "Create Markdown, HTML, spreadsheets, Kanban boards, team views, and charts in one workspace.",
  },
  {
    icon: FolderTree,
    category: "Structure",
    title: "Projects & nested folders",
    description:
      "Group documents into projects, with nested folders and files inside each, mirroring how you think.",
  },
  {
    icon: Users,
    category: "Presence",
    title: "Real-time collaboration",
    description:
      "Multiple people work on the same file simultaneously, live, with presence and instant sync.",
  },
  {
    icon: History,
    category: "Recovery",
    title: "Version history",
    description:
      "Track every change to a document and roll back to any previous revision whenever you need to.",
  },
  {
    icon: Share2,
    category: "Publishing",
    title: "Shareable links",
    description:
      "Publish read-only links to a single document or a whole project, with access you control.",
  },
  {
    icon: Building2,
    category: "Workspace",
    title: "Organizations",
    description:
      "Create an organization that holds multiple projects for your team, with per-project access.",
  },
];

export function Features() {
  return (
    <Section id="features">
      <Reveal>
        <SectionHeader
          kicker="Features"
          title="Everything a document workspace needs."
          description="A focused set of primitives for organizing and collaborating on written and structured work."
        />
      </Reveal>

      <Panel label="Core primitives" meta="06 capabilities" className="mt-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, index) => (
            <div
              key={feature.title}
              className={cn(
                "group border-hairline p-6 transition-colors duration-200 hover:bg-foreground/[0.035]",
                index > 0 && "border-t",
                index % 2 === 1 && "sm:border-l",
                index === 1 && "sm:border-t-0",
                index === 2 && "lg:border-t-0 lg:border-l",
                index === 3 && "lg:border-l-0",
                index >= 4 && "lg:border-l",
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <span className="press-shadow flex size-10 items-center justify-center rounded-md border border-hairline bg-surface/65 transition-colors duration-200 group-hover:border-accent/50">
                  <feature.icon className="size-4 text-foreground transition-colors duration-200 group-hover:text-accent" />
                </span>
                <span className="font-mono text-muted-foreground text-xs">
                  {String(index + 1).padStart(2, "0")}
                </span>
              </div>
              <span className="mt-6 block font-medium font-mono text-[0.68rem] text-accent uppercase tracking-widest">
                {feature.category}
              </span>
              <h3 className="mt-2 font-semibold text-base tracking-display">{feature.title}</h3>
              <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </Panel>
    </Section>
  );
}

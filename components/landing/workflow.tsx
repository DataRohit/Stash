import { Panel } from "@/components/landing/panel";
import { Reveal } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";
import { SectionHeader } from "@/components/landing/section-header";

const steps = [
  {
    phase: "Setup",
    title: "Create a project",
    description: "Spin up a project and structure it with nested folders that match your work.",
    output: "Project space",
  },
  {
    phase: "Content",
    title: "Add your documents",
    description: "Write Markdown or HTML. Files live inside folders, organized however you like.",
    output: "Docs & folders",
  },
  {
    phase: "Access",
    title: "Invite collaborators",
    description: "Add teammates to a project and manage their access per project, not per file.",
    output: "Team permissions",
  },
  {
    phase: "Sync",
    title: "Edit together, live",
    description: "Multiple people work on the same document in real time, with presence and sync.",
    output: "Live session",
  },
  {
    phase: "Publish",
    title: "Share & track history",
    description: "Publish read-only links and roll back to any earlier revision with full history.",
    output: "Links & versions",
  },
];

export function Workflow() {
  return (
    <Section id="workflow">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
        <Reveal className="lg:col-span-4">
          <SectionHeader
            kicker="Workflow"
            title="From empty project to live collaboration."
            description="Five steps. No setup ceremony, no plugins — just structured documents your whole team can edit."
          />
        </Reveal>

        <div className="lg:col-span-7 lg:col-start-6">
          <Panel label="Document pipeline" meta="05 steps">
            <ol className="divide-y divide-hairline">
              {steps.map((step, index) => (
                <li
                  key={step.title}
                  className="group grid grid-cols-[4rem_1fr] transition-colors duration-200 hover:bg-foreground/[0.035]"
                >
                  <div className="relative flex justify-center border-hairline border-r bg-foreground/[0.018] px-3 py-4">
                    {index < steps.length - 1 ? (
                      <span
                        className="absolute top-[3.25rem] bottom-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-hairline to-transparent"
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="press-shadow relative z-10 flex size-9 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface/70 font-mono font-semibold text-foreground text-xs transition-colors duration-200 group-hover:border-accent/50 group-hover:text-accent">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </div>

                  <div className="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-start sm:px-6">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-base tracking-display">{step.title}</h3>
                      <p className="mt-2 max-w-xl text-muted-foreground text-sm leading-relaxed">
                        {step.description}
                      </p>
                    </div>

                    <div className="hidden min-w-36 flex-col items-end gap-2 pt-0.5 sm:flex">
                      <span className="font-medium font-mono text-[0.68rem] text-accent uppercase tracking-widest">
                        {step.phase}
                      </span>
                      <span className="rounded-sm border border-hairline bg-surface/45 px-2.5 py-1 font-mono text-muted-foreground text-xs">
                        {step.output}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </Section>
  );
}

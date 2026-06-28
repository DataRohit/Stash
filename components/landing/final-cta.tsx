import { ArrowRight } from "lucide-react";
import { Panel } from "@/components/landing/panel";
import { Reveal } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

const nextSteps = ["Clone the repo", "Configure Convex", "Invite your team"];

export function FinalCta() {
  return (
    <Section className="py-24 sm:py-32">
      <Reveal className="mx-auto max-w-5xl">
        <Panel label="Launch path" meta="Open source" className="glass-strong">
          <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_18rem] lg:items-center">
            <div>
              <h2 className="max-w-2xl font-serif text-4xl leading-tight tracking-display sm:text-5xl">
                Start building your document workspace today.
              </h2>
              <p className="mt-4 max-w-xl text-muted-foreground leading-relaxed">
                Open source, self-hostable, and built on a reactive backend. Clone the repository
                and run it locally in minutes.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <a
                  href={site.repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ size: "lg" }), "group")}
                >
                  View on GitHub
                  <ArrowRight className="cta-arrow size-4" />
                </a>
                <a
                  href={site.readme}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
                >
                  Read the docs
                </a>
              </div>
            </div>

            <div className="border-hairline border-t pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
              <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
                Next steps
              </span>
              <ol className="mt-4 flex flex-col gap-3">
                {nextSteps.map((step, index) => (
                  <li key={step} className="flex items-center gap-3 text-sm">
                    <span className="press-shadow flex size-8 shrink-0 items-center justify-center rounded-[6px] border border-hairline bg-surface/60 font-mono text-xs">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </Panel>
      </Reveal>
    </Section>
  );
}

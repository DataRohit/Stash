import { ArrowRight } from "lucide-react";
import { GridBackground } from "@/components/landing/grid-background";
import { Reveal } from "@/components/landing/reveal";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-hairline border-b">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <div className="hero-fade grid-bg absolute inset-0" />
        <GridBackground />
      </div>
      <div className="mx-auto max-w-7xl px-6 pt-28 pb-24 sm:pt-36 sm:pb-32">
        <Reveal className="flex flex-col items-start gap-7">
          <Badge variant="surface">
            <span className="live-dot size-1.5" aria-hidden="true" />
            v0.1 • Early Access Open
          </Badge>

          <h1 className="max-w-3xl font-serif text-5xl leading-[0.98] tracking-display sm:text-6xl md:text-7xl">
            A workspace for
            <br />
            Markdown &amp; HTML docs.
          </h1>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="solid">Open Source</Badge>
            <Badge variant="outline">Real-Time</Badge>
            <Badge variant="outline">Self-Hostable</Badge>
          </div>

          <p className="max-w-xl text-base text-muted-foreground leading-relaxed">
            Host documentation, plans, and notes in projects with nested folders. Invite
            collaborators, share read-only links, keep full version history, and edit the same file
            together in real time.
          </p>

          <div className="flex flex-col gap-3 sm:flex-row">
            <a
              href={site.readme}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: "lg" }), "group")}
            >
              Get started
              <ArrowRight className="cta-arrow size-4" />
            </a>
            <a
              href="#workflow"
              className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
            >
              See how it works
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

import { AuthEntryButton } from "@/components/landing/auth-entry-button";
import { Reveal } from "@/components/landing/reveal";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-hairline border-b">
      <div className="mx-auto max-w-7xl px-4 pt-28 pb-20 sm:px-6 sm:pt-36 sm:pb-32">
        <Reveal className="flex flex-col items-start gap-7">
          <Badge variant="surface">
            <span className="live-dot size-1.5" aria-hidden="true" />
            v0.1 • Early Access Open
          </Badge>

          <h1 className="max-w-3xl font-serif text-4xl leading-[0.98] tracking-display sm:text-6xl md:text-7xl">
            A workspace for
            <br />
            docs &amp; structured data.
          </h1>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="solid">Open Source</Badge>
            <Badge variant="outline">Real-Time</Badge>
            <Badge variant="outline">Self-Hostable</Badge>
          </div>

          <p className="max-w-xl text-base text-muted-foreground leading-relaxed">
            Build documents, spreadsheets, Kanban boards, team views, and charts in projects with
            nested folders. Collaborate in real time, keep full history, and share controlled
            read-only links.
          </p>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <AuthEntryButton
              signedOutLabel="Get started"
              signedInLabel="Open dashboard"
              className="w-full sm:w-auto"
            />
            <a
              href="#workflow"
              className={cn(
                buttonVariants({ variant: "secondary", size: "lg" }),
                "w-full sm:w-auto",
              )}
            >
              See how it works
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

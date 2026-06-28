import { Check } from "lucide-react";
import { Panel } from "@/components/landing/panel";
import { Reveal } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";
import { SectionHeader } from "@/components/landing/section-header";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

const plans = [
  {
    name: "Free",
    blurb: "For individuals getting started.",
    price: "$0",
    period: "forever",
    highlight: false,
    cta: "Join the waitlist",
    href: site.issues,
    features: [
      "1 organization",
      "5 projects per organization",
      "5 collaborators per project",
      "Public share links",
      "7-day version history",
      "8 MB max project size",
      "Community support",
    ],
  },
  {
    name: "Pro",
    blurb: "For power users and small teams.",
    price: "$9",
    period: "/ month",
    highlight: true,
    cta: "Join the waitlist",
    href: site.issues,
    features: [
      "5 organizations",
      "25 projects per organization",
      "100 collaborators per project",
      "Public share links",
      "350-day version history",
      "64 MB max project size",
      "Priority support",
    ],
  },
  {
    name: "Team",
    blurb: "For organizations that need scale.",
    price: "Custom",
    period: "",
    highlight: false,
    cta: "Get in touch",
    href: site.issues,
    features: [
      "Unlimited organizations",
      "Unlimited projects per organization",
      "Unlimited collaborators per project",
      "Public share links",
      "Unlimited version history",
      "512 MB max project size",
      "Dedicated support",
    ],
  },
];

export function Pricing() {
  return (
    <Section id="pricing">
      <Reveal>
        <SectionHeader
          kicker="Pricing"
          title="Free to self-host. Simple plans when you don't."
          description="Self-host Stash for free with no limits at all. Or use the hosted platform — these plans are indicative while the project is in early development."
        />
      </Reveal>

      <Panel label="Deployment option" meta="Free forever" className="glass-strong mt-12">
        <div className="grid gap-5 p-6 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="flex items-start gap-3">
            <span className="live-dot mt-1.5 size-1.5 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <h3 className="font-mono font-semibold text-sm uppercase tracking-widest">
                Self-hosted Stash
              </h3>
              <p className="max-w-xl text-muted-foreground text-sm leading-relaxed">
                Run Stash on your own infrastructure with unlimited organizations, projects,
                collaborators, and version history. No quotas, no limits.
              </p>
            </div>
          </div>
          <a
            href={site.readme}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "secondary" }))}
          >
            Self-hosting guide
          </a>
        </div>
      </Panel>

      <Panel label="Hosted plans" meta="Indicative pricing" className="mt-5">
        <div className="grid grid-cols-1 lg:grid-cols-3">
          {plans.map((plan, index) => (
            <div
              key={plan.name}
              className={cn(
                "relative flex flex-col gap-6 border-hairline p-6 transition-colors duration-200 hover:bg-foreground/[0.035]",
                index > 0 && "border-t lg:border-t-0 lg:border-l",
                plan.highlight && "bg-foreground/[0.025]",
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <h3 className="font-mono font-semibold text-sm uppercase tracking-widest">
                    {plan.name}
                  </h3>
                  <p className="text-muted-foreground text-sm">{plan.blurb}</p>
                </div>
                {plan.highlight ? (
                  <span className="press-shadow rounded-[5px] border border-accent/35 bg-accent/10 px-2 py-0.5 font-medium font-mono text-[0.68rem] text-accent uppercase tracking-wider">
                    Popular
                  </span>
                ) : null}
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="font-serif text-4xl tracking-display">{plan.price}</span>
                {plan.period ? (
                  <span className="text-muted-foreground text-sm">{plan.period}</span>
                ) : null}
              </div>
              <ul className="flex flex-1 flex-col gap-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-sm">
                    <Check
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        plan.highlight ? "text-accent" : "text-muted-foreground",
                      )}
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                href={plan.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  buttonVariants({ variant: plan.highlight ? "primary" : "secondary" }),
                  "mt-auto",
                )}
              >
                {plan.cta}
              </a>
            </div>
          ))}
        </div>
      </Panel>
    </Section>
  );
}

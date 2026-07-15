import { Panel } from "@/components/landing/panel";
import { PricingPlans } from "@/components/landing/pricing-plans";
import { Reveal } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";
import { SectionHeader } from "@/components/landing/section-header";
import { buttonVariants } from "@/components/ui/button";
import { getBillingPlans } from "@/lib/billing";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

export async function Pricing() {
  const plans = await getBillingPlans();

  return (
    <Section id="pricing">
      <Reveal>
        <SectionHeader
          kicker="Pricing"
          title="Free to self-host. Simple plans when you don't."
          description="Self-host Stash for free with deployment-controlled policies. Or use the hosted platform — these plans are indicative while the project is in early development."
        />
      </Reveal>

      <Panel label="Deployment option" meta="Deployment controlled" className="glass-strong mt-12">
        <div className="grid gap-5 p-6 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="flex items-start gap-3">
            <span className="live-dot mt-1.5 size-1.5 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <h3 className="font-mono font-semibold text-sm uppercase tracking-widest">
                Self-hosted Stash
              </h3>
              <p className="max-w-xl text-muted-foreground text-sm leading-relaxed">
                Run Stash on your own infrastructure and configure organization, project,
                collaborator, storage, and history policies for your deployment.
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

      <PricingPlans plans={plans} />
    </Section>
  );
}

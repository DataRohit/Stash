"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { Panel } from "@/components/landing/panel";
import { buttonVariants } from "@/components/ui/button";
import type { BillingPlan } from "@/lib/billing";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

type PricingPlansProps = {
  plans: BillingPlan[];
};

export function PricingPlans({ plans }: PricingPlansProps) {
  const [annual, setAnnual] = useState(false);
  const hasAnnual = plans.some((plan) => plan.hasAnnual);
  const maxSavings = Math.max(0, ...plans.map((plan) => plan.annualSavingsPercent));

  const toggle = hasAnnual ? (
    <div className="flex items-center gap-2">
      {annual && maxSavings > 0 ? (
        <span className="hidden font-medium font-mono text-[0.68rem] text-accent uppercase leading-none tracking-wider sm:inline-flex sm:items-center">
          Save {maxSavings}%
        </span>
      ) : null}
      <div className="flex items-center gap-1 rounded-[7px] border border-hairline bg-foreground/[0.03] p-0.5">
        <button
          type="button"
          onClick={() => setAnnual(false)}
          className={cn(
            "cursor-pointer rounded-[5px] px-2.5 py-1 font-medium font-mono text-xs uppercase tracking-wider transition-colors",
            annual
              ? "text-muted-foreground hover:text-foreground"
              : "bg-foreground/10 text-foreground",
          )}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setAnnual(true)}
          className={cn(
            "cursor-pointer rounded-[5px] px-2.5 py-1 font-medium font-mono text-xs uppercase tracking-wider transition-colors",
            annual
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Annual
        </button>
      </div>
    </div>
  ) : (
    "Indicative pricing"
  );

  return (
    <Panel label="Hosted plans" meta={toggle} className="mt-5">
      <div className="grid grid-cols-1 sm:grid-cols-2">
        {plans.map((plan, index) => {
          const price = annual && plan.hasAnnual ? plan.priceAnnualMonthly : plan.priceMonthly;
          const period = plan.isFree
            ? "forever"
            : annual && plan.hasAnnual
              ? "/ mo, billed yearly"
              : "/ month";
          const priceNote = plan.isFree
            ? "No credit card required"
            : annual && plan.hasAnnual
              ? `${plan.annualTotal} billed once a year`
              : "Cancel anytime";

          return (
            <div
              key={plan.id}
              className={cn(
                "relative flex flex-col gap-6 border-hairline p-6 transition-colors duration-200 hover:bg-foreground/[0.035]",
                index > 0 && "border-t sm:border-t-0 sm:border-l",
                plan.isPopular && "bg-foreground/[0.025]",
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <h3 className="font-mono font-semibold text-sm uppercase tracking-widest">
                    {plan.name}
                  </h3>
                  {plan.description ? (
                    <p className="min-h-10 text-muted-foreground text-sm">{plan.description}</p>
                  ) : null}
                </div>
                {plan.isPopular ? (
                  <span className="press-shadow rounded-[5px] border border-accent/35 bg-accent/10 px-2 py-0.5 font-medium font-mono text-[0.68rem] text-accent uppercase tracking-wider">
                    Popular
                  </span>
                ) : null}
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-serif text-4xl tracking-display">{price}</span>
                  <span className="text-muted-foreground text-sm">{period}</span>
                </div>
                <span className="block min-h-4 text-muted-foreground text-xs">{priceNote}</span>
              </div>

              {plan.features.length > 0 ? (
                <ul className="flex flex-1 flex-col gap-3">
                  {plan.features.map((feature) => (
                    <li key={feature.id} className="flex items-start gap-2.5 text-sm">
                      <Check
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          plan.isPopular ? "text-accent" : "text-muted-foreground",
                        )}
                        aria-hidden="true"
                      />
                      {feature.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex-1" />
              )}

              <a
                href={site.issues}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  buttonVariants({ variant: plan.isPopular ? "primary" : "secondary" }),
                  "mt-auto",
                )}
              >
                Join the waitlist
              </a>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

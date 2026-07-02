const CLERK_API_BASE = "https://api.clerk.com/v1";
const REVALIDATE_SECONDS = 60;

type PlanFeature = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

export type BillingPlan = {
  id: string;
  name: string;
  slug: string;
  description: string;
  isFree: boolean;
  isPopular: boolean;
  priceMonthly: string;
  priceAnnualMonthly: string;
  annualTotal: string;
  hasAnnual: boolean;
  annualSavingsPercent: number;
  features: PlanFeature[];
};

type ClerkFee = {
  amount: number;
  currency_symbol: string;
};

type ClerkFeature = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

type ClerkPlan = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_default: boolean;
  has_base_fee: boolean;
  publicly_visible: boolean;
  for_payer_type: string;
  fee: ClerkFee;
  annual_monthly_fee: ClerkFee;
  annual_fee: ClerkFee;
  features: ClerkFeature[];
};

const FALLBACK_PLANS: BillingPlan[] = [
  {
    id: "free",
    name: "Free",
    slug: "free_user",
    description: "For individuals getting started with a single workspace.",
    isFree: true,
    isPopular: false,
    priceMonthly: "$0",
    priceAnnualMonthly: "$0",
    annualTotal: "$0",
    hasAnnual: false,
    annualSavingsPercent: 0,
    features: [],
  },
  {
    id: "pro",
    name: "Pro",
    slug: "pro_user",
    description: "For power users and small teams that need more room.",
    isFree: false,
    isPopular: true,
    priceMonthly: "$5",
    priceAnnualMonthly: "$4.60",
    annualTotal: "$55.20",
    hasAnnual: true,
    annualSavingsPercent: 8,
    features: [],
  },
];

function formatPrice(fee: ClerkFee): string {
  const symbol = fee.currency_symbol || "$";
  const value = fee.amount / 100;
  const display = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `${symbol}${display}`;
}

function savingsPercent(monthly: ClerkFee, annual: ClerkFee): number {
  const fullYear = monthly.amount * 12;
  if (fullYear <= 0 || annual.amount <= 0) {
    return 0;
  }
  return Math.round(((fullYear - annual.amount) / fullYear) * 100);
}

function mapPlan(plan: ClerkPlan): BillingPlan {
  return {
    id: plan.id,
    name: plan.name,
    slug: plan.slug,
    description: plan.description ?? "",
    isFree: plan.is_default,
    isPopular: plan.has_base_fee && !plan.is_default,
    priceMonthly: formatPrice(plan.fee),
    priceAnnualMonthly: formatPrice(plan.annual_monthly_fee),
    annualTotal: formatPrice(plan.annual_fee),
    hasAnnual: plan.annual_fee.amount > 0,
    annualSavingsPercent: savingsPercent(plan.fee, plan.annual_fee),
    features: plan.features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      slug: feature.slug,
      description: feature.description,
    })),
  };
}

export async function getBillingPlans(): Promise<BillingPlan[]> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return FALLBACK_PLANS;
  }

  try {
    const response = await fetch(`${CLERK_API_BASE}/billing/plans`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!response.ok) {
      return FALLBACK_PLANS;
    }

    const body = (await response.json()) as { data: ClerkPlan[] };
    const plans = body.data
      .filter((plan) => plan.publicly_visible && plan.for_payer_type === "user")
      .sort((a, b) => a.fee.amount - b.fee.amount)
      .map(mapPlan);

    return plans.length > 0 ? plans : FALLBACK_PLANS;
  } catch {
    return FALLBACK_PLANS;
  }
}

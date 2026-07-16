import { auth } from "@clerk/nextjs/server";

const CLERK_API_BASE = "https://api.clerk.com/v1";
const SUBSCRIPTION_CACHE_TTL_MS = 60_000;
const SUBSCRIPTION_FETCH_TIMEOUT_MS = 3_000;
const MAX_SUBSCRIPTION_CACHE_ENTRIES = 256;

type ClerkPlan = {
  slug: string;
  is_default: boolean;
  for_payer_type: string;
  features: { slug: string }[];
};

type ClerkSubscriptionItem = {
  status: string;
  plan: ClerkPlan;
  plan_period: "month" | "year" | null;
  period_end: number | null;
  canceled_at: number | null;
};

type ClerkSubscription = {
  subscription_items: ClerkSubscriptionItem[];
};

export type UserSubscription = {
  planSlug: string;
  isPro: boolean;
  featureSlugs: string[];
  planPeriod: "month" | "year" | null;
  periodEnd: number | null;
  canceled: boolean;
  degraded: boolean;
};

const FREE_SUBSCRIPTION: UserSubscription = {
  planSlug: "free_user",
  isPro: false,
  featureSlugs: [],
  planPeriod: null,
  periodEnd: null,
  canceled: false,
  degraded: false,
};

const subscriptionCache = new Map<string, { value: UserSubscription; expiresAt: number }>();

export async function getUserSubscriptionFor(
  userId: string,
  refresh = false,
): Promise<UserSubscription> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return { ...FREE_SUBSCRIPTION, degraded: true };
  }
  const cached = refresh ? undefined : subscriptionCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    subscriptionCache.delete(userId);
    subscriptionCache.set(userId, cached);
    return cached.value;
  }

  try {
    const response = await fetch(`${CLERK_API_BASE}/users/${userId}/billing/subscription`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(SUBSCRIPTION_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ...FREE_SUBSCRIPTION, degraded: true };
    }

    const subscription = (await response.json()) as ClerkSubscription;
    const activeUserItems = subscription.subscription_items.filter(
      (item) => item.status === "active" && item.plan.for_payer_type === "user",
    );
    const item = activeUserItems.find((entry) => !entry.plan.is_default) ?? activeUserItems[0];

    if (!item) {
      return FREE_SUBSCRIPTION;
    }

    const value = {
      planSlug: item.plan.slug,
      isPro: !item.plan.is_default,
      featureSlugs: item.plan.features.map((feature) => feature.slug),
      planPeriod: item.plan_period,
      periodEnd: item.period_end,
      canceled: item.canceled_at != null,
      degraded: false,
    };
    while (subscriptionCache.size >= MAX_SUBSCRIPTION_CACHE_ENTRIES) {
      const oldest = subscriptionCache.keys().next().value;
      if (typeof oldest !== "string") break;
      subscriptionCache.delete(oldest);
    }
    subscriptionCache.set(userId, {
      value,
      expiresAt: Date.now() + SUBSCRIPTION_CACHE_TTL_MS,
    });
    return value;
  } catch {
    return { ...FREE_SUBSCRIPTION, degraded: true };
  }
}

export async function getUserSubscription(): Promise<UserSubscription> {
  const { userId } = await auth();
  return userId ? await getUserSubscriptionFor(userId) : { ...FREE_SUBSCRIPTION, degraded: true };
}

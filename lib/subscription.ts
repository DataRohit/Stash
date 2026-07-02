import { auth } from "@clerk/nextjs/server";

const CLERK_API_BASE = "https://api.clerk.com/v1";

type ClerkPlan = {
  slug: string;
  is_default: boolean;
  for_payer_type: string;
  features: { slug: string }[];
};

type ClerkSubscriptionItem = {
  status: string;
  plan: ClerkPlan;
};

type ClerkSubscription = {
  subscription_items: ClerkSubscriptionItem[];
};

export type UserSubscription = {
  planSlug: string;
  isPro: boolean;
  featureSlugs: string[];
};

const FREE_SUBSCRIPTION: UserSubscription = {
  planSlug: "free_user",
  isPro: false,
  featureSlugs: [],
};

export async function getUserSubscription(): Promise<UserSubscription> {
  const { userId } = await auth();
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!userId || !secretKey) {
    return FREE_SUBSCRIPTION;
  }

  try {
    const response = await fetch(`${CLERK_API_BASE}/users/${userId}/billing/subscription`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      cache: "no-store",
    });
    if (!response.ok) {
      return FREE_SUBSCRIPTION;
    }

    const subscription = (await response.json()) as ClerkSubscription;
    const activeUserItems = subscription.subscription_items.filter(
      (item) => item.status === "active" && item.plan.for_payer_type === "user",
    );
    const item = activeUserItems.find((entry) => !entry.plan.is_default) ?? activeUserItems[0];

    if (!item) {
      return FREE_SUBSCRIPTION;
    }

    return {
      planSlug: item.plan.slug,
      isPro: !item.plan.is_default,
      featureSlugs: item.plan.features.map((feature) => feature.slug),
    };
  } catch {
    return FREE_SUBSCRIPTION;
  }
}

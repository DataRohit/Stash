import type { NextConfig } from "next";

function origin(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function websocketOrigin(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    else return "";
    return url.origin;
  } catch {
    return "";
  }
}

function sources(...values: string[]): string {
  return [...new Set(values.filter(Boolean))].join(" ");
}

const clerkOrigin = origin(process.env.CLERK_JWT_ISSUER_DOMAIN);
const clerkScriptSource = clerkOrigin ? ` ${clerkOrigin}` : "";
const convexOrigin = origin(process.env.NEXT_PUBLIC_CONVEX_URL);
const convexSiteOrigin = origin(process.env.NEXT_PUBLIC_CONVEX_SITE_URL);
const convexWebSocketOrigin = websocketOrigin(process.env.NEXT_PUBLIC_CONVEX_URL);
const challengeOrigin = ["https:", "", "challenges.cloudflare.com"].join("/");
const connectPolicy = `connect-src ${sources(
  "'self'",
  "https:",
  "wss:",
  convexOrigin,
  convexSiteOrigin,
  convexWebSocketOrigin,
)}`;
const imagePolicy = `img-src ${sources("'self'", "https:", "data:", "blob:", convexSiteOrigin)}`;
const scriptPolicy =
  process.env.NODE_ENV === "development"
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval'${clerkScriptSource} ${challengeOrigin}`
    : `script-src 'self' 'unsafe-inline'${clerkScriptSource} ${challengeOrigin}`;

const nextConfig: NextConfig = {
  allowedDevOrigins: ["integral-mentally-alpaca.ngrok-free.app"],
  experimental: {
    viewTransition: true,
  },
  serverExternalPackages: ["@resvg/resvg-js"],
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; ${imagePolicy}; font-src 'self' https: data:; ${connectPolicy}; worker-src 'self' blob:; frame-src 'self' blob: ${challengeOrigin}; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`,
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
      {
        source: "/share/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src https: data:; font-src 'self' https: data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;

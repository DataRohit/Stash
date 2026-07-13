import type { NextConfig } from "next";

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
        source: "/share/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src https: data:; font-src 'self' https: data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;

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
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;

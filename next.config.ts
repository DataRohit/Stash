import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["integral-mentally-alpaca.ngrok-free.app"],
  experimental: {
    viewTransition: true,
  },
  serverExternalPackages: ["@resvg/resvg-js"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;

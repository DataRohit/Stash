import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["integral-mentally-alpaca.ngrok-free.app"],
  experimental: {
    viewTransition: true,
  },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;

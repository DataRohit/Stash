import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    viewTransition: true,
  },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;

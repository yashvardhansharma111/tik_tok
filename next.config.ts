import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Large video uploads (default proxy buffer is 10MB). See Next.js "proxyClientMaxBodySize".
    proxyClientMaxBodySize: "500mb",
  },
};

export default nextConfig;

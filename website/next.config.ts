import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // Keep RSC/prefetch headers visible so content negotiation can bypass navigation.
  skipProxyUrlNormalize: true,
  outputFileTracingRoot: path.join(__dirname, ".."),
  turbopack: { root: path.join(__dirname, "..") },
  async redirects() {
    return [
      { source: "/", destination: "/docs/getting-started/introduction", permanent: true },
      { source: "/docs/specification/:path*", destination: "/specification/:path*", permanent: true },
      { source: "/docs/reference/:path*", destination: "/specification/reference/:path*", permanent: true },
    ];
  },
};

export default nextConfig;

import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  outputFileTracingRoot: path.join(__dirname, ".."),
  turbopack: { root: path.join(__dirname, "..") },
  async redirects() {
    return [
      { source: "/docs/specification/:path*", destination: "/specification/:path*", permanent: true },
      { source: "/docs/reference/:path*", destination: "/specification/reference/:path*", permanent: true },
    ];
  },
};

export default nextConfig;

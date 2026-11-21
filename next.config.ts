import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API routes are named route.node.ts.
  pageExtensions: ["tsx", "ts", "node.ts"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

import type { NextConfig } from "next";

/**
 * Two build modes:
 *
 *   next dev / next build / next start  — Node app (local). /api/bars is the
 *     Next.js route in src/app/api. Alpaca keys stay in .env.local (server).
 *
 *   NAMECOM_EXPORT=1 next build         — static HTML/CSS/JS into /out, for
 *     Name.com public_html. There is no Node runtime on that host. /api/bars
 *     is rewritten by .htaccess to hosting/api/bars.php, which holds the keys
 *     server-side. Never put Alpaca keys in NEXT_PUBLIC_* ; they would ship
 *     in the JS chunks.
 *
 * Optional public (non-secret) vars, inlined at build time:
 *   NEXT_PUBLIC_BASE_PATH       e.g. "" (domain root) or "/polarito"
 *   NEXT_PUBLIC_BARS_ENDPOINT   default "/api/bars" (our proxy, not Alpaca)
 */
const namecomExport = process.env.NAMECOM_EXPORT === "1";
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  // Local: route.node.ts is the Node proxy. Name.com export: that file is
  // ignored so /out/api/bars.php is not overwritten by a static stub.
  pageExtensions: namecomExport ? ["tsx", "ts"] : ["tsx", "ts", "node.ts"],
  ...(namecomExport
    ? {
        output: "export" as const,
        trailingSlash: true,
        images: { unoptimized: true },
        ...(basePath ? { basePath, assetPrefix: basePath } : {}),
      }
    : {
        cacheComponents: true,
        partialPrefetching: true,
      }),
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

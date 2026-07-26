import type { NextConfig } from "next";

// CDN_HOST matches terraform/modules/cloudfront's `cdn.${var.domain_name}`
// alias — every MediaAsset.url returned by the backend (SPEC-02) is an
// absolute CloudFront URL on that host, which next/image requires an
// explicit remotePattern for.
const cdnHost = process.env.NEXT_PUBLIC_CDN_HOST ?? "cdn.dev.pk-literature.example";

const nextConfig: NextConfig = {
  // packages/ui ships raw .tsx (no build step of its own — see its
  // README) — Next transpiles it itself rather than requiring every
  // component change to go through a separate `tsc` build first.
  transpilePackages: ["@pk-literature/ui"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: cdnHost,
      },
    ],
  },
};

export default nextConfig;

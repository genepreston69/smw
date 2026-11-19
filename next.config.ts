import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Capitalized Labor and Capitalized Materials were combined into
  // Capitalized Jobs; old links and bookmarks keep working (the period
  // params in the query string pass through).
  redirects() {
    return [
      {
        source: "/capitalized-labor/:path*",
        destination: "/capitalized-jobs/:path*",
        permanent: true,
      },
      {
        source: "/capitalized-materials",
        destination: "/capitalized-jobs",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  // Production builds were exhausting the 8 GB build machine while compiling:
  // restoring and re-serialising the persistent webpack cache (425 MB for the
  // OpsPulse project) on top of the compile itself. Keep the compile cache in
  // memory only for production builds; `next dev` keeps its disk cache.
  webpack: (config, { dev }) => {
    if (config.cache && !dev) config.cache = Object.freeze({ type: "memory" });
    return config;
  },
  experimental: {
    // A custom webpack function turns the separate build worker off by default;
    // keep it on so each compilation's memory is released when it finishes.
    webpackBuildWorker: true,
    outputFileTracingIncludes: { "/api/ops-pulse/audits/export": ["./assets/report-fonts/**/*"], "/api/ops-pulse/reports/reviews": ["./assets/report-fonts/**/*"], "/api/ops-pulse/audits/report/*": ["./assets/report-fonts/**/*"], "/ops-pulse/audits": ["./assets/report-fonts/**/*"] },
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;

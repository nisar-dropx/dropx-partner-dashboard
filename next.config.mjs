/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  // Production builds were exhausting the 8 GB build machine while compiling:
  // restoring and re-serialising the persistent webpack cache (425 MB for the
  // OpsPulse project) on top of the compile itself. Keep the compile cache in
  // memory only for production builds; `next dev` keeps its disk cache.
  webpack: (config, { dev, isServer }) => {
    if (config.cache && !dev) config.cache = Object.freeze({ type: "memory" });
    // @resvg/resvg-js ships a prebuilt native .node binary; webpack cannot parse it.
    // satori imports it transitively. Both are only used in Node.js Route Handlers,
    // so marking them external is safe and correct.
    if (isServer) {
      config.externals = [...(config.externals ?? []), "@resvg/resvg-js", "satori"];
    }
    return config;
  },
  experimental: {
    // A custom webpack function turns the separate build worker off by default;
    // keep it on so each compilation's memory is released when it finishes.
    webpackBuildWorker: true,
    outputFileTracingIncludes: {
      "/api/cron/report-bot": ["./assets/report-fonts/**/*"],
      "/api/ops-pulse/ai-report": ["./assets/report-fonts/**/*"],
      "/api/ops-pulse/store-audits/report/*": ["./assets/report-fonts/**/*"],
      "/ops-pulse/store-audits": ["./assets/report-fonts/**/*"],
      "/api/ops-pulse/audits/export": ["./assets/report-fonts/**/*"],
      "/api/ops-pulse/reports/reviews": ["./assets/report-fonts/**/*"],
      "/api/ops-pulse/audits/report/*": ["./assets/report-fonts/**/*"],
      "/ops-pulse/audits": ["./assets/report-fonts/**/*"],
      "/api/cron/dark-store-ppi": ["./src/app/api/cron/dark-store-ppi/*.ttf"],
    },
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;

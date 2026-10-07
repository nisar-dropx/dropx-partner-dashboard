/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  // Bound build memory for the shared OpsPulse route graph. Runtime caching is unchanged.
  webpack(config, { dev }) {
    if (!dev) {
      config.cache = false;
      config.parallelism = 20;
    }
    return config;
  },
  experimental: {
    cpus: 2,
    webpackBuildWorker: true,
    outputFileTracingIncludes: { "/api/ops-pulse/reports/reviews": ["./assets/report-fonts/**/*"], "/api/ops-pulse/audits/report/*": ["./assets/report-fonts/**/*"], "/ops-pulse/audits": ["./assets/report-fonts/**/*"] },
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  experimental: {
    outputFileTracingIncludes: { "/api/ops-pulse/reports/reviews": ["./assets/report-fonts/**/*"] },
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;

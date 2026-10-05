/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  experimental: {
    outputFileTracingIncludes: { "/api/ops-pulse/reports/reviews": ["./assets/report-fonts/**/*"], "/api/ops-pulse/audits/report/*": ["./assets/report-fonts/**/*"], "/ops-pulse/audits": ["./assets/report-fonts/**/*"] },
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;

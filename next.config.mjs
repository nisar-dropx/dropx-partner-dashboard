/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  experimental: {
    outputFileTracingIncludes: { "/finance/business/export": ["./assets/report-fonts/NotoSans-Regular.ttf"], "/api/ops-pulse/reports/reviews": ["./assets/report-fonts/**/*"], "/api/ops-pulse/audits/report/*": ["./assets/report-fonts/**/*"], "/ops-pulse/audits": ["./assets/report-fonts/**/*"] },
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;

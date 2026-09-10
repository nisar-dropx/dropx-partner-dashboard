/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { outputFileTracingIncludes: { "/api/ops-pulse/reports/reviews": ["./assets/report-fonts/**/*"] } }
};

export default nextConfig;

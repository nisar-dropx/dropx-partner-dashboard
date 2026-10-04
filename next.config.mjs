/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  async headers() {
    return [
      {
        source: "/downloads/DropX-Fleet-v2.1.0-arm64.apk",
        headers: [
          { key: "Content-Type", value: "application/vnd.android.package-archive" },
          { key: "Content-Disposition", value: 'attachment; filename="DropX-Fleet-v2.1.0-arm64.apk"' },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Content-Type-Options", value: "nosniff" }
        ]
      },
      {
        source: "/downloads/DropX-Fleet-v2.1.0-32bit.apk",
        headers: [
          { key: "Content-Type", value: "application/vnd.android.package-archive" },
          { key: "Content-Disposition", value: 'attachment; filename="DropX-Fleet-v2.1.0-32bit.apk"' },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Content-Type-Options", value: "nosniff" }
        ]
      }
    ];
  },
  experimental: {
    outputFileTracingIncludes: { "/api/ops-pulse/reports/reviews": ["./assets/report-fonts/**/*"] },
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow Connect API routes to reuse monorepo root libs (attendance reports, etc.).
  experimental: {
    externalDir: true
  }
};

export default nextConfig;

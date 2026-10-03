export type ProviderMappingPageCode = "provider_mapping" | "ops_provider_mapping";

function normalizedHost(value: string | null | undefined) {
  const host = String(value ?? "").trim().toLowerCase();
  if (!host || host.includes(",")) return "";
  return host.split(":")[0];
}

export function providerMappingPageCodeForHost(value: string | null | undefined): ProviderMappingPageCode | null {
  const host = normalizedHost(value);
  if (host === "ops.dropxlogistics.com" || /^ops-[a-z0-9-]+\.vercel\.app$/.test(host)) {
    return "ops_provider_mapping";
  }
  if (
    host === "dashboard.dropxlogistics.com" ||
    host === "dropx-partner-dashboard.vercel.app" ||
    /^dropx-partner-dashboard-[a-z0-9-]+\.vercel\.app$/.test(host) ||
    host === "localhost" ||
    host === "127.0.0.1"
  ) {
    return "provider_mapping";
  }
  return null;
}

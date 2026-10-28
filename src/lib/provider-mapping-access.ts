import "server-only";

import { headers } from "next/headers";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { providerMappingPageCodeForHost, providerMappingSummaryPageCodeForHost, type ProviderMappingPageCode, type ProviderMappingSummaryPageCode } from "@/lib/provider-mapping-host";

export type { ProviderMappingPageCode } from "@/lib/provider-mapping-host";
export type { ProviderMappingSummaryPageCode } from "@/lib/provider-mapping-host";

export function providerMappingPageCodeForCurrentHost(): ProviderMappingPageCode | null {
  return providerMappingPageCodeForHost(headers().get("host"));
}

export function currentProviderMappingPageCode(): ProviderMappingPageCode {
  const pageCode = providerMappingPageCodeForCurrentHost();
  if (!pageCode) throw new Error("Provider mapping is not available on this application host.");
  return pageCode;
}

export function currentProviderMappingSummaryPageCode(): ProviderMappingSummaryPageCode {
  const pageCode = providerMappingSummaryPageCodeForHost(headers().get("host"));
  if (!pageCode) throw new Error("Provider mapping summary is not available on this application host.");
  return pageCode;
}

export function canEditProviderMappings(authorization: AuthorizationContext) {
  const pageCode = currentProviderMappingPageCode();
  return hasPermission(authorization, pageCode, "edit");
}

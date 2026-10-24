import { supabaseAdmin } from "@/lib/supabase-admin";
import { cache } from "react";
import type { AuthorizationContext } from "@/lib/authorization";
import { previewProductCode } from "@/lib/portal-preview";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import { documentInWorkspace, type DocumentScope } from "@/lib/business-document-workspace-policy";

// A workspace is a filter in addition to authorization, including for owners.
export const businessDocumentWorkspace = cache(async (auth: AuthorizationContext) => {
  if (previewProductCode() !== "operations") return null;
  const result = await loadCodLocations(auth.companyId!, auth.locationScopeIds, auth.hasAllLocationAccess);
  if (result.error) throw new Error("Unable to verify document workspace. Please retry.");
  const context = resolveOperatingContext(result.locations);
  if (!context.selectedLocations.length) return [];
  if (!supabaseAdmin) throw new Error("Unable to verify document scope.");
  const metadata = await supabaseAdmin.from("stations").select("id,state,provider_id").eq("company_id", auth.companyId!).in("id", context.selectedLocations.map(l => l.id));
  if (metadata.error) throw new Error("Unable to verify document scope.");
  return context.selectedLocations.map(l => ({ ...l, ...metadata.data.find(row => row.id === l.id) }));
});

export async function documentMatchesWorkspace(auth: AuthorizationContext, document: DocumentScope) {
  const locations = await businessDocumentWorkspace(auth);
  return locations === null || documentInWorkspace(document, locations);
}

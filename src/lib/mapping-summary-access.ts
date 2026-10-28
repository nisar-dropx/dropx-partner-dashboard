/** Summary is read-only oversight for everyone already allowed into ID Mapping.
 * Its own designation/role grant still permits summary-only access. */
export function inheritsMappingSummaryAccess(
  permissions: Record<string, {canView: boolean; canAdd: boolean; canEdit: boolean}>,
  pageCode: string, action: string,
) {
  if (action !== "access" && action !== "view") return false;
  const parent = pageCode === "ops_provider_mapping_summary" ? "ops_provider_mapping"
    : pageCode === "provider_mapping_summary" ? "provider_mapping" : "";
  const grant = permissions[parent];
  return Boolean(parent && grant && (grant.canView || grant.canAdd || grant.canEdit));
}

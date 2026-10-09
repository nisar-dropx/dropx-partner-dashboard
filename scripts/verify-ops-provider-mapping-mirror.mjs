import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const middleware = read("src/middleware.ts");
const dashboardNavigation = read("src/lib/app-navigation.ts");
const navigation = read("src/lib/ops-pulse/navigation.ts");
const accessSurface = read("src/lib/access-surface.ts");
const accessPages = read("src/lib/access-pages.ts");
const permissions = read("src/components/permission-matrix.tsx");
const authorization = read("src/lib/authorization.ts");
const access = read("src/lib/provider-mapping-access.ts");
const hostAccess = read("src/lib/provider-mapping-host.ts");
const canonicalPage = read("src/app/provider-id-mapping/page.tsx");
const legacyProviderFirstPage = read("src/app/provider-mapping/provider-first/page.tsx");
const directPayPage = read("src/app/provider-mapping/direct-pay/page.tsx");
const actions = read("src/app/provider-mapping/actions.ts");
const directPayActions = read("src/app/provider-mapping/direct-pay/actions.ts");
const lookupApi = read("src/app/api/provider-mapping/member-lookup/route.ts");
const migration = read("supabase/migrations/20261003123618_ops_provider_mapping_access.sql");
const locationRemapMigration = read("supabase/migrations/20261005124958_provider_mapping_drift_and_period_corrections.sql");
const multiLocationMigration = read("supabase/migrations/20261009173118_workforce_provider_mapping_multi_location.sql");

const opsCodes = accessSurface.match(/export const opsAccessPageCodes = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
const legacyProviderMappingPredicate = middleware.match(/const isLegacyProviderMappingIndex = ([^;]+);/)?.[1]?.trim() ?? "";
const legacyProviderMappingRedirect = middleware.match(/if \(isLegacyProviderMappingIndex\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
const workforceRegisterPosition = navigation.indexOf('{ code: "delivery_associates", label: "Workforce Register"');
const idMappingPosition = navigation.indexOf('{ code: "ops_provider_mapping", label: "ID Mapping"');
const workforcePayoutPosition = navigation.indexOf('{ code: "ops_workforce_payouts", label: "Workforce Payouts"');

const checks = [
  [middleware.includes('path === "/provider-id-mapping"') && middleware.includes("providerMappingPageCodeForHost(host)"), "Middleware must allow the canonical provider ID mapping route only on recognized Dashboard and Ops hosts."],
  [legacyProviderMappingPredicate === 'path === "/provider-mapping" || path === "/provider-mapping/provider-first"', "Only the two legacy ID Mapping landing URLs may redirect to the canonical page; Direct pay must remain reachable."],
  [legacyProviderMappingRedirect.includes("request.nextUrl.clone()") && legacyProviderMappingRedirect.includes('canonicalUrl.pathname = "/provider-id-mapping"') && legacyProviderMappingRedirect.includes("NextResponse.redirect(canonicalUrl, 308)") && !legacyProviderMappingRedirect.includes("canonicalUrl.search"), "Legacy ID Mapping redirects must preserve q, station, and all other query parameters."],
  [workforceRegisterPosition >= 0 && idMappingPosition > workforceRegisterPosition && idMappingPosition < workforcePayoutPosition, "Ops navigation must place ID Mapping between Workforce Register and Workforce Payouts."],
  [dashboardNavigation.includes('{ code: "provider_mapping", label: "ID Mapping", href: "/provider-id-mapping"'), "Dashboard navigation must use the canonical provider ID mapping URL."],
  [navigation.includes('{ code: "ops_provider_mapping", label: "ID Mapping", href: "/provider-id-mapping"'), "Ops navigation must use the canonical provider ID mapping URL."],
  [opsCodes.includes('"ops_provider_mapping"'), "The Ops ID Mapping permission must admit granted users to the Ops surface."],
  [permissions.includes('{ key: "ops_provider_mapping", label: "ID Mapping", codes: ["ops_provider_mapping"] }'), "Ops role setup must expose ID Mapping with View/Add/Edit controls."],
  [accessPages.includes('{ code: "ops_provider_mapping", name: "ID Mapping"') && migration.includes("'ops_provider_mapping'"), "The Ops ID Mapping page must be provisioned without copying Dashboard grants."],
  [authorization.includes('"ops_provider_mapping"'), "The authorization catalog must recognize the Ops ID Mapping page."],
  [access.includes('headers().get("host")') && access.includes("providerMappingPageCodeForCurrentHost") && !access.includes("x-forwarded-host"), "Provider mapping permission selection must use the same trusted Host value as middleware."],
  [accessSurface.indexOf('headers().get("host")') < accessSurface.indexOf('headers().get("x-forwarded-host")'), "Authorization role and location scope must prefer the same Host value used by middleware."],
  [hostAccess.includes('host === "ops.dropxlogistics.com"') && hostAccess.includes('host === "dashboard.dropxlogistics.com"') && hostAccess.includes("return null"), "Provider mapping must use isolated permissions on recognized Dashboard and Ops hosts and deny other surfaces."],
  [canonicalPage.includes("currentProviderMappingPageCode()") && canonicalPage.includes('requirePagePermission(pageCode, "access")') && canonicalPage.includes("pageCode={pageCode}"), "The canonical provider-first page must enforce the host-specific permission without changing its UI."],
  [legacyProviderFirstPage.includes('redirect("/provider-id-mapping")') && !legacyProviderFirstPage.includes("currentProviderMappingPageCode"), "The legacy provider-first route must stay redirect-only so its build entry does not retain the heavy mapping graph."],
  [canonicalPage.includes('href="/provider-id-mapping"') && directPayPage.includes('href="/provider-id-mapping"') && !canonicalPage.includes("Existing worksheet") && !directPayPage.includes("Existing worksheet") && !canonicalPage.includes('/provider-mapping/provider-first') && !directPayPage.includes('/provider-mapping/provider-first'), "Both mapping views must use the canonical URL and omit the legacy Existing worksheet tab and route."],
  [directPayPage.includes("currentProviderMappingPageCode()") && directPayPage.includes('requirePagePermission(pageCode, "access")') && directPayPage.includes("pageCode={pageCode}"), "Direct-pay must enforce the host-specific permission without changing its UI."],
  [actions.includes("canEditProviderMappings(authorization)") && directPayActions.includes("canEditProviderMappings(authorization)"), "All mapping writes must enforce the host-specific Add/Edit grant."],
  [lookupApi.includes("providerMappingPageCodeForCurrentHost()") && lookupApi.includes("authorization.locationScopeIds") && lookupApi.includes('.in("station_code", stationCodes)'), "The member lookup API must enforce the recognized host, Ops grant, and assigned-location scope."],
  [canonicalPage.includes("authorization.locationScopeIds") && actions.includes("assertProviderFirstRowScope") && actions.includes('select("id, location_id")') && actions.includes("locationRemapFromStationId") && actions.includes('sourceType !== "workforce"'), "Provider mapping reads and writes must remain scoped to assigned locations and canonical workforce records."],
  [actions.includes('select("id, effective_from, effective_to, station_id') && actions.includes("existing.station_id") && actions.includes("workerMapping.station_id"), "Bulk, legacy, and provider-first updates must reject existing mappings outside the assigned-location scope."],
  [actions.includes("providerFirstReplacementState") && actions.includes("expectedReplacementId === existingMapping.id") && actions.includes("existing provider mapping is outside your allocated locations") && actions.includes("workforce_replace_joining_mapping") && actions.includes("workforce_keep_joining_mapping") && actions.includes('replacementAction === "keep"'), "Provider-first replacements must confirm the exact active mapping, preserve location scope, and use an audited Move or Keep all transaction."],
  [actions.includes('rpc("workforce_active_provider_member_mappings"') && actions.includes("providerMemberIdentity(currentMapping.provider_member_id)") && !actions.includes('.eq("provider_member_id", providerMemberId)') && multiLocationMigration.includes("upper(btrim(mapping.provider_member_id))") && multiLocationMigration.includes("upper(btrim(p_provider_member_id))"), "Keep all and clear must resolve Provider Member IDs with the same trim- and case-insensitive identity used by the database constraints."],
  [multiLocationMigration.includes("workforce_provider_member_owner_guard") && multiLocationMigration.includes("All simultaneous location mappings for a Provider ID must use the same DropX ID") && multiLocationMigration.includes("workforce_clear_joining_mapping") && multiLocationMigration.includes("from public, anon, authenticated") && multiLocationMigration.includes("to service_role"), "Keep all and clear must enforce one canonical DropX owner at the database boundary, preserve history, and remain service-role only."],
  [locationRemapMigration.includes("workforce_rebase_payment_policy_location") && locationRemapMigration.includes("provider_mapping_location_moved") && locationRemapMigration.includes("target.id <> old_mapping.id") && locationRemapMigration.includes("person.location_id is distinct from new_station_id") && locationRemapMigration.includes("from public, anon, authenticated") && locationRemapMigration.includes("to service_role"), "Location remaps must preserve policy history, support a profile already at the destination, audit the move, exclude only the confirmed old mapping, and remain service-role only."],
  [locationRemapMigration.includes("provider_mapping_start_corrected") && locationRemapMigration.includes("effective_from = m.effective_from") && locationRemapMigration.includes("Finalized Workforce payroll uses this mapping period") && locationRemapMigration.includes("coalesce(payroll_item.status, '') <> 'excluded'") && locationRemapMigration.includes("least(new_start, old_mapping.effective_from)"), "Mapping start corrections and location replacements must preserve an audit event, block participating finalized payroll conflicts, and ignore excluded payroll items."],
  [actions.includes("existingCurrentMapping") && actions.includes("An active mapping already exists"), "Legacy save endpoints must not create a second active mapping when the client omits a mapping ID."],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Ops ID Mapping mirror verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Ops ID Mapping mirror verified.");

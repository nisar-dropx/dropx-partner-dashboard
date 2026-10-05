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
  [canonicalPage.includes("authorization.locationScopeIds") && actions.includes("assertProviderFirstRowScope") && actions.includes('.eq("location_id", stationId)') && actions.includes('sourceType !== "workforce"'), "Provider mapping reads and writes must remain scoped to assigned locations and canonical workforce records."],
  [actions.includes('select("id, effective_from, effective_to, station_id') && actions.includes("existing.station_id") && actions.includes("workerMapping.station_id"), "Bulk, legacy, and provider-first updates must reject existing mappings outside the assigned-location scope."],
  [actions.includes("providerFirstReplacementState") && actions.includes("expectedReplacementId === providerMapping!.id") && actions.includes("existing provider mapping is outside your allocated locations") && actions.includes("workforce_replace_joining_mapping"), "Provider-first replacements must confirm the exact active mapping, preserve location scope, and use the audited replacement transaction."],
  [actions.includes("existingCurrentMapping") && actions.includes("An active mapping already exists"), "Legacy save endpoints must not create a second active mapping when the client omits a mapping ID."],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Ops ID Mapping mirror verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Ops ID Mapping mirror verified.");

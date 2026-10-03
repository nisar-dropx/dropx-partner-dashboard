import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const middleware = read("src/middleware.ts");
const navigation = read("src/lib/ops-pulse/navigation.ts");
const accessSurface = read("src/lib/access-surface.ts");
const accessPages = read("src/lib/access-pages.ts");
const permissions = read("src/components/permission-matrix.tsx");
const authorization = read("src/lib/authorization.ts");
const access = read("src/lib/provider-mapping-access.ts");
const hostAccess = read("src/lib/provider-mapping-host.ts");
const providerFirstPage = read("src/app/provider-mapping/provider-first/page.tsx");
const directPayPage = read("src/app/provider-mapping/direct-pay/page.tsx");
const actions = read("src/app/provider-mapping/actions.ts");
const directPayActions = read("src/app/provider-mapping/direct-pay/actions.ts");
const lookupApi = read("src/app/api/provider-mapping/member-lookup/route.ts");
const migration = read("supabase/migrations/20261003123618_ops_provider_mapping_access.sql");

const opsCodes = accessSurface.match(/export const opsAccessPageCodes = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
const workforceRegisterPosition = navigation.indexOf('{ code: "delivery_associates", label: "Workforce Register"');
const idMappingPosition = navigation.indexOf('{ code: "ops_provider_mapping", label: "ID Mapping"');
const workforcePayoutPosition = navigation.indexOf('{ code: "ops_workforce_payouts", label: "Workforce Payouts"');

const checks = [
  [middleware.includes('path === "/provider-mapping" || path.startsWith("/provider-mapping/")') && middleware.includes("providerMappingPageCodeForHost(host)"), "Middleware must allow the shared provider-mapping route tree only on recognized Dashboard and Ops hosts."],
  [workforceRegisterPosition >= 0 && idMappingPosition > workforceRegisterPosition && idMappingPosition < workforcePayoutPosition, "Ops navigation must place ID Mapping between Workforce Register and Workforce Payouts."],
  [opsCodes.includes('"ops_provider_mapping"'), "The Ops ID Mapping permission must admit granted users to the Ops surface."],
  [permissions.includes('{ key: "ops_provider_mapping", label: "ID Mapping", codes: ["ops_provider_mapping"] }'), "Ops role setup must expose ID Mapping with View/Add/Edit controls."],
  [accessPages.includes('{ code: "ops_provider_mapping", name: "ID Mapping"') && migration.includes("'ops_provider_mapping'"), "The Ops ID Mapping page must be provisioned without copying Dashboard grants."],
  [authorization.includes('"ops_provider_mapping"'), "The authorization catalog must recognize the Ops ID Mapping page."],
  [access.includes('headers().get("host")') && access.includes("providerMappingPageCodeForCurrentHost") && !access.includes("x-forwarded-host"), "Provider mapping permission selection must use the same trusted Host value as middleware."],
  [accessSurface.indexOf('headers().get("host")') < accessSurface.indexOf('headers().get("x-forwarded-host")'), "Authorization role and location scope must prefer the same Host value used by middleware."],
  [hostAccess.includes('host === "ops.dropxlogistics.com"') && hostAccess.includes('host === "dashboard.dropxlogistics.com"') && hostAccess.includes("return null"), "Provider mapping must use isolated permissions on recognized Dashboard and Ops hosts and deny other surfaces."],
  [providerFirstPage.includes("currentProviderMappingPageCode()") && providerFirstPage.includes('requirePagePermission(pageCode, "access")') && providerFirstPage.includes("pageCode={pageCode}"), "Provider-first must enforce the host-specific permission without changing its UI."],
  [directPayPage.includes("currentProviderMappingPageCode()") && directPayPage.includes('requirePagePermission(pageCode, "access")') && directPayPage.includes("pageCode={pageCode}"), "Direct-pay must enforce the host-specific permission without changing its UI."],
  [actions.includes("canEditProviderMappings(authorization)") && directPayActions.includes("canEditProviderMappings(authorization)"), "All mapping writes must enforce the host-specific Add/Edit grant."],
  [lookupApi.includes("providerMappingPageCodeForCurrentHost()") && lookupApi.includes("authorization.locationScopeIds") && lookupApi.includes('.in("station_code", stationCodes)'), "The member lookup API must enforce the recognized host, Ops grant, and assigned-location scope."],
  [providerFirstPage.includes("authorization.locationScopeIds") && actions.includes("assertProviderFirstRowScope") && actions.includes('.eq("location_id", stationId)') && actions.includes('sourceType !== "workforce"'), "Provider mapping reads and writes must remain scoped to assigned locations and canonical workforce records."],
  [actions.includes('select("id, effective_from, effective_to, station_id")') && actions.includes("existing.station_id") && actions.includes("workerMapping.station_id"), "Bulk, legacy, and provider-first updates must reject existing mappings outside the assigned-location scope."],
  [actions.includes('select("id, provider_member_id, station_id")') && actions.includes("currentMapping.station_id") && actions.includes("submittedMappingId"), "Provider-first saves must preserve the active mapping identity and reject out-of-scope mapping history."],
  [actions.includes("existingCurrentMapping") && actions.includes("An active mapping already exists"), "Legacy save endpoints must not create a second active mapping when the client omits a mapping ID."],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Ops ID Mapping mirror verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Ops ID Mapping mirror verified.");

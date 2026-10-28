import Link from "next/link";
import {AppShell} from "@/components/app-shell";
import {PageHead} from "@/components/page-head";
import {ProviderMappingSummary} from "@/components/provider-mapping-summary";
import {hasPermission, requirePagePermission} from "@/lib/authorization";
import {requireCompanyId} from "@/lib/company-scope";
import {dashboardDateInputValue} from "@/lib/date-format";
import {
  currentProviderMappingPageCode,
  currentProviderMappingSummaryPageCode
} from "@/lib/provider-mapping-access";
import {
  canonicalizeProviderFirstMembers,
  providerFirstMappingIsCurrentOrScheduled,
  providerSourceMemberKey
} from "@/lib/provider-first-mapping-view";
import {parseProductionThresholdConfig} from "@/lib/production-threshold-config";
import {parseProductionThresholdSnapshot} from "@/lib/production-threshold-snapshot";
import {buildProviderMappingSummary} from "@/lib/provider-mapping-summary";
import {readAllRows} from "@/lib/supabase-pagination";
import {supabaseAdmin} from "@/lib/supabase-admin";

type StationRow = {id:string;station_code:string;station_name:string|null};
type SourceRow = {provider_employee_id:unknown;provider_employee_name:unknown;station_code:unknown;work_date:unknown};
type MappingRow = {id:string;station_id:string|null;provider_member_id:string;workforce_id:string|null;payment_method_id:string|null;payment_values:Record<string,unknown>|null;production_threshold_config:unknown;effective_from:string;effective_to:string|null;status:string;updated_at:string};
type WorkerRow = {id:string;dropx_id:string|null;full_name:string|null};
type MethodRow = {id:string;name:string;production_threshold_config:unknown;payment_method_components:Array<{component_code:string;is_active:boolean}>|null};

export const dynamic = "force-dynamic";

export default async function ProviderMappingSummaryPage() {
  const pageCode = currentProviderMappingSummaryPageCode();
  const mappingPageCode = currentProviderMappingPageCode();
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const allLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const scope = new Set(authorization.locationScopeIds);
  const allowed = (stationId: string | null) => allLocations || Boolean(stationId && scope.has(stationId));

  if (!supabaseAdmin) return <AppShell active="Mapping Summary" pageCode={pageCode}>
    <PageHead eyebrow="Source-of-truth bridge" title="Mapping summary" />
    <section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">Mapping data is temporarily unavailable.</p></div></section>
  </AppShell>;

  const [stationResult, sourceResult, mappingResult, workerResult, methodResult] = await Promise.all([
    supabaseAdmin.from("stations").select("id,station_code,station_name").eq("company_id",companyId).order("station_code"),
    supabaseAdmin.rpc("ops_cps_mapping_members",{p_company:companyId,p_station_ids:allLocations?null:authorization.locationScopeIds}),
    readAllRows(supabaseAdmin.from("field_executive_provider_mappings").select("id,station_id,provider_member_id,workforce_id,payment_method_id,payment_values,production_threshold_config,effective_from,effective_to,status,updated_at").eq("company_id",companyId).order("effective_from",{ascending:false}).order("updated_at",{ascending:false})),
    readAllRows(supabaseAdmin.from("workforce").select("id,dropx_id,full_name").eq("company_id",companyId).is("deleted_at",null)),
    supabaseAdmin.from("payment_methods").select("id,name,production_threshold_config,payment_method_components(component_code,is_active)").eq("company_id",companyId)
  ]);
  const loadError = stationResult.error || sourceResult.error || mappingResult.error || workerResult.error || methodResult.error;
  const stations = ((stationResult.data ?? []) as StationRow[]).filter(station => allowed(station.id));
  const stationCodeById = new Map(stations.map(station => [station.id,station.station_code]));
  const allMappings = ((mappingResult.data ?? []) as MappingRow[]).filter(mapping => allowed(mapping.station_id));
  const protectedSourceKeys = new Set(allMappings.map(mapping => providerSourceMemberKey(stationCodeById.get(String(mapping.station_id ?? "")) ?? "*",mapping.provider_member_id)));
  const sourceMembers = canonicalizeProviderFirstMembers(((sourceResult.data ?? []) as SourceRow[]).map(source => ({
    providerMemberId:String(source.provider_employee_id??"").trim(),
    providerMemberName:String(source.provider_employee_name??"").trim(),
    stationCode:String(source.station_code??"").trim(),
    workDate:String(source.work_date??"").trim()
  })),protectedSourceKeys);
  const methods = ((methodResult.data ?? []) as MethodRow[]).map(method => ({
    id:method.id,
    name:method.name,
    componentCodes:(method.payment_method_components??[]).filter(component=>component.is_active!==false).map(component=>component.component_code),
    productionThresholdRequired:Boolean(parseProductionThresholdConfig(method.production_threshold_config))
  }));
  const methodById = new Map(methods.map(method=>[method.id,method]));
  const today = dashboardDateInputValue();
  const summary = buildProviderMappingSummary({
    stations:stations.map(station=>({id:station.id,code:station.station_code,name:station.station_name})),
    sourceMembers,
    mappings:allMappings.filter(mapping=>mapping.station_id&&providerFirstMappingIsCurrentOrScheduled({status:mapping.status,effectiveTo:mapping.effective_to},today)).map(mapping=>({
      id:mapping.id,
      stationId:String(mapping.station_id),
      providerMemberId:mapping.provider_member_id,
      workforceId:mapping.workforce_id,
      paymentMethodId:mapping.payment_method_id,
      paymentValues:mapping.payment_values,
      productionThresholdReady:!methodById.get(String(mapping.payment_method_id??""))?.productionThresholdRequired||Boolean(parseProductionThresholdSnapshot(mapping.production_threshold_config)),
      effectiveFrom:mapping.effective_from,
      updatedAt:mapping.updated_at
    })),
    workers:((workerResult.data??[]) as WorkerRow[]).map(worker=>({id:worker.id,dropxId:worker.dropx_id,fullName:worker.full_name})),
    methods
  });
  const canOpenMapping = hasPermission(authorization,mappingPageCode,"access");

  return <AppShell active="Mapping Summary" pageCode={pageCode}>
    <PageHead eyebrow="Source-of-truth bridge" title="Mapping summary" subtitle="Station-level ID and payment mapping health, with drill-down to every missing record." />
    <nav className="performance-tabs" aria-label="ID mapping views">
      {canOpenMapping?<Link href="/provider-id-mapping">Provider member first</Link>:null}
      {canOpenMapping?<Link href="/provider-mapping/direct-pay">Direct pay allocations</Link>:null}
      <Link className="active" href="/provider-id-mapping/summary">Mapping summary</Link>
    </nav>
    {loadError?<section className="panel message-panel error"><div className="panel-body"><strong>Unable to load mapping summary</strong><p className="subtle">{loadError.message}</p></div></section>:<ProviderMappingSummary stations={summary}/>} 
  </AppShell>;
}

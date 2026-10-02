import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { callWorkforceAmazonWorker, workforceAmazonWorkerConfig } from "@/lib/workforce-amazon-worker";
import { enableMissingAmazonStations, refreshClientIdWorker, saveClientIdStation } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = { station?: string; notice?: string; error?: string };
type Provider = { name?: string | null };
type Station = {
  id: string;
  station_code: string;
  station_name: string | null;
  hide_from_location_list?: boolean | null;
  parent_station_id?: string | null;
  providers?: Provider | Provider[] | null;
};
type Setting = {
  station_id: string;
  service_area_code: string;
  amazon_service_area_id: string | null;
  service_type: string;
  supervisor_alias: string;
  contract_type: string;
  associate_email_pattern: string | null;
  invitation_enabled: boolean;
  version: number;
  updated_at: string;
};
type ServiceArea = { service_area_id: string; service_area_name: string; station_code: string; station_state: string | null };
type WorkerCredentialStatus = { workforce: boolean; idfy: boolean };

function relation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function when(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "Not yet";
}

export default async function ClientIdMasterPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("delivery_associates", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.delivery_associates ?? { canView: false, canAdd: false, canEdit: false };
  const canEdit = Boolean(permission.canEdit && !authorization.readOnly);
  if (!supabaseAdmin) throw new Error("Client ID master is unavailable.");

  const workerConfig = workforceAmazonWorkerConfig();
  const workerProbe = workerConfig.configured
    ? callWorkforceAmazonWorker<WorkerCredentialStatus>("/api/admin/credentials/status", { signal: AbortSignal.timeout(10_000) })
        .then((data) => ({ data, error: null as Error | null }))
        .catch((error) => ({ data: null, error: error instanceof Error ? error : new Error("Worker status is unavailable.") }))
    : Promise.resolve({ data: null, error: new Error("OpsPulse deployment variables are not configured.") });

  const [stationResult, settingResult, areaResult, defaultResult, supervisorResult, syncResult, workerResult] = await Promise.all([
    supabaseAdmin.from("stations").select("id,station_code,station_name,hide_from_location_list,parent_station_id,providers(name)").eq("company_id", companyId).eq("is_active", true).order("station_code").limit(500),
    supabaseAdmin.from("workforce_amazon_station_settings").select("station_id,service_area_code,amazon_service_area_id,service_type,supervisor_alias,contract_type,associate_email_pattern,invitation_enabled,version,updated_at").eq("company_id", companyId),
    supabaseAdmin.from("workforce_amazon_service_areas").select("service_area_id,service_area_name,station_code,station_state").eq("company_id", companyId).order("station_code"),
    supabaseAdmin.from("workforce_amazon_supervisor_defaults").select("supervisor_alias").eq("company_id", companyId).maybeSingle(),
    supabaseAdmin.from("workforce_amazon_supervisors").select("supervisor_alias,display_name,is_active").eq("company_id", companyId).eq("is_active", true).order("supervisor_alias"),
    supabaseAdmin.from("workforce_amazon_sync_state").select("status,last_attempt_at,last_success_at,matched_count,missing_count").eq("company_id", companyId).maybeSingle(),
    workerProbe
  ]);
  const firstError = stationResult.error || settingResult.error || areaResult.error || defaultResult.error || supervisorResult.error || syncResult.error;
  const allStations = filterOnboardingLocations((stationResult.data ?? []) as Station[], authorization);
  const stations = allStations.filter((station) => String(relation(station.providers)?.name ?? "").toLowerCase().includes("amazon") && !/^TEST(?:\s|$)/i.test(station.station_code));
  const settings = (settingResult.data ?? []) as Setting[];
  const settingByStation = new Map(settings.map((setting) => [setting.station_id, setting]));
  const areas = (areaResult.data ?? []) as ServiceArea[];
  const areaByCode = new Map(areas.map((area) => [area.station_code.toUpperCase(), area]));
  const selectedStation = stations.find((station) => station.id === searchParams?.station) ?? stations[0] ?? null;
  const current = selectedStation ? settingByStation.get(selectedStation.id) ?? null : null;
  const selectedArea = selectedStation ? areaByCode.get(selectedStation.station_code.toUpperCase()) ?? null : null;
  const defaultSupervisor = String(defaultResult.data?.supervisor_alias ?? "");
  const enabled = stations.filter((station) => settingByStation.get(station.id)?.invitation_enabled).length;
  const held = stations.filter((station) => { const setting = settingByStation.get(station.id); return Boolean(setting && !setting.invitation_enabled); }).length;
  const reviewed = stations.filter((station) => settingByStation.has(station.id)).length;
  const unsynced = stations.filter((station) => !areaByCode.has(station.station_code.toUpperCase())).length;
  const sync = syncResult.data;
  const workerConnected = Boolean(workerResult.data);

  return <AppShell active="Client ID Master" pageCode="delivery_associates"><div className="ops-command-center client-id-master">
    <PageHead
      eyebrow="Ops Masters · Workforce"
      title="Client ID Master"
      subtitle="Stationwise Amazon LSC invitation setup. Service area, supervisor badge, contract type and worker connection are controlled here."
      action={<Link className="button secondary" href="/work-force-register?tab=amazon-id">Open Client ID queue</Link>}
    />
    {searchParams?.notice ? <div className="message-panel success">{searchParams.notice}</div> : null}
    {searchParams?.error || firstError ? <div className="message-panel error">{searchParams?.error || firstError?.message}</div> : null}

    <section className="performance-summary-grid">
      <article><span>Amazon stations</span><strong>{stations.length}</strong><small>Active stations in your scope</small></article>
      <article><span>Invitation enabled</span><strong>{enabled}</strong><small>{held} on hold · {Math.max(0, stations.length - reviewed)} require setup</small></article>
      <article><span>Service area sync</span><strong>{Math.max(0, stations.length - unsynced)}</strong><small>{unsynced} station{unsynced === 1 ? "" : "s"} not yet synced</small></article>
      <article><span>Amazon LSC worker</span><strong>{workerConnected && workerResult.data?.workforce ? "Connected" : "Attention needed"}</strong><small>{workerConnected ? "Cloudflare connection verified" : "OpsPulse cannot reach the worker"}</small></article>
      <article><span>IDfy worker</span><strong>{workerConnected && workerResult.data?.idfy ? "Connected" : "Attention needed"}</strong><small>{workerResult.data?.idfy ? "IDfy credentials available" : "Credential check failed"}</small></article>
    </section>

    {authorization.hasAllLocationAccess && canEdit ? <section className="panel client-id-bulk-panel"><div className="panel-head"><div><h2>Shared station rollout</h2><p className="subtle">Configure only stations without a saved setup. Existing enabled and on-hold stations are preserved.</p></div><form action={enableMissingAmazonStations}><SubmitButton className="button" pendingText="Configuring stations" confirmMessage={`Configure missing Amazon stations with supervisor ${defaultSupervisor || "the configured default"}?`} confirmTitle="Configure missing Amazon stations" confirmDescription="Each station is mapped only to its own synced service area. Existing enabled or on-hold setups will not be changed." disabled={!defaultSupervisor || reviewed === stations.length}>{reviewed === stations.length ? "All stations reviewed" : "Configure missing stations"}</SubmitButton></form></div></section> : null}

    <div className="client-id-master-layout">
      <section className="panel client-id-station-list">
        <div className="panel-head"><div><h2>Stations</h2><p className="subtle">Choose a station to review or edit its setup.</p></div></div>
        <div className="client-id-station-links">{stations.map((station) => { const setting = settingByStation.get(station.id); const area = areaByCode.get(station.station_code.toUpperCase()); const status = setting ? (setting.invitation_enabled ? "Enabled" : "On hold") : "Setup"; return <Link key={station.id} href={`/master/client-id?station=${station.id}`} className={selectedStation?.id === station.id ? "active" : ""}><span><strong>{station.station_code}</strong><small>{station.station_name || "Station name pending"}</small></span><span className={`status-pill ${setting?.invitation_enabled ? "good" : "warn"}`}>{status}</span>{!area ? <small className="client-id-sync-warning">Service area not synced</small> : null}</Link>; })}{!stations.length ? <div className="empty-state">No Amazon stations are available in your location scope.</div> : null}</div>
      </section>

      {selectedStation ? <section key={selectedStation.id} className="panel client-id-station-editor">
        <div className="panel-head"><div><p className="eyebrow">Station configuration</p><h2>{selectedStation.station_code} · {selectedStation.station_name || "Amazon station"}</h2><p className="subtle">These values are used when an OpsPulse user sends the client invitation.</p></div><span className={`status-pill ${current?.invitation_enabled ? "good" : "warn"}`}>{current?.invitation_enabled ? "Invitation enabled" : current ? "On hold" : "Setup required"}</span></div>
        <form key={selectedStation.id} action={saveClientIdStation} className="form-grid two client-id-station-form">
          <input type="hidden" name="station_id" value={selectedStation.id}/>
          <input type="hidden" name="version" value={current?.version ?? 0}/>
          <label>Amazon service area<input className="field" value={selectedArea ? `${selectedArea.station_code} · ${selectedArea.service_area_name}${selectedArea.station_state ? ` (${selectedArea.station_state})` : ""}` : "Not synced"} readOnly/><small>Matched automatically from this station's Amazon service-area sync.</small></label>
          <label>Amazon service-area code<input className="field" name="service_area_code" value={selectedStation.station_code.toUpperCase()} readOnly/><small>Locked to the selected station.</small></label>
          <label>Supervisor badge login<select className="field" name="supervisor_alias" required defaultValue={current?.supervisor_alias || defaultSupervisor}><option value="" disabled>Select supervisor badge</option>{(supervisorResult.data ?? []).map((supervisor) => <option key={supervisor.supervisor_alias} value={supervisor.supervisor_alias}>{supervisor.supervisor_alias}{supervisor.display_name ? ` · ${supervisor.display_name}` : ""}</option>)}</select><small>This is the station fallback and can be changed independently later.</small></label>
          <label>Approved DA contract type<select className="field" name="contract_type" required defaultValue={current?.contract_type || "Independent Contractor"}><option>Independent Contractor</option><option>Subcontractor</option><option>DSP Employed</option></select></label>
          <label>Service type<input className="field" value="Amazon Logistics" readOnly/></label>
          <label>Example associate email pattern <span className="subtle">optional</span><input className="field" name="associate_email_pattern" maxLength={254} defaultValue={current?.associate_email_pattern || ""} placeholder="{first_name}.{station_code}@yourdomain.com"/></label>
          <label className="checkbox-row span-2"><input name="invitation_enabled" type="checkbox" defaultChecked={current?.invitation_enabled ?? false}/> Enable Create Amazon ID for this station</label>
          <div className="form-actions span-2"><SubmitButton disabled={!canEdit} disabledText="Read-only access" pendingText="Saving station">Save station setup</SubmitButton>{current?.updated_at ? <span className="subtle">Last updated {when(current.updated_at)}</span> : null}</div>
        </form>
      </section> : null}
    </div>

    <section className="panel client-id-worker-panel" id="worker-connection">
      <div className="panel-head"><div><p className="eyebrow">Shared Cloudflare worker</p><h2>Amazon LSC and IDfy connection</h2><p className="subtle">OpsPulse uses the existing secure Workforce worker. Portal passwords stay in Cloudflare and are never entered or displayed here.</p></div><span className={`status-pill ${workerConnected && workerResult.data?.workforce && workerResult.data?.idfy ? "good" : "warn"}`}>{workerConnected ? "Worker reachable" : "Connection failed"}</span></div>
      <div className="panel-body">
        <div className="client-id-worker-health"><span>Amazon LSC credentials <b>{workerResult.data?.workforce ? "Available" : "Unavailable"}</b></span><span>IDfy credentials <b>{workerResult.data?.idfy ? "Available" : "Unavailable"}</b></span><span>Last successful Amazon scan <b>{when(sync?.last_success_at)}</b></span><span>Latest scan <b>{sync?.matched_count ?? 0} matched · {sync?.missing_count ?? 0} missing</b></span></div>
        {workerResult.error ? <p className="ops-workforce-error"><strong>Worker check failed.</strong> {workerResult.error.message}</p> : null}
        {canEdit ? <form action={refreshClientIdWorker}><SubmitButton className="button secondary" pendingText="Checking Amazon LSC and IDfy">Run live worker check</SubmitButton></form> : null}
      </div>
    </section>
  </div></AppShell>;
}

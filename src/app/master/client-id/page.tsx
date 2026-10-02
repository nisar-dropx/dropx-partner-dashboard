import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { isCompanyOwner, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { enableMissingAmazonStations, saveAmazonOnboardingConnection, saveClientIdStation } from "./actions";

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
  const owner = isCompanyOwner(authorization);
  if (!supabaseAdmin) throw new Error("Client ID master is unavailable.");

  const [stationResult, settingResult, areaResult, defaultResult, supervisorResult, connectionResult, syncResult] = await Promise.all([
    supabaseAdmin.from("stations").select("id,station_code,station_name,hide_from_location_list,parent_station_id,providers(name)").eq("company_id", companyId).eq("is_active", true).order("station_code").limit(500),
    supabaseAdmin.from("workforce_amazon_station_settings").select("station_id,service_area_code,amazon_service_area_id,service_type,supervisor_alias,contract_type,associate_email_pattern,invitation_enabled,version,updated_at").eq("company_id", companyId),
    supabaseAdmin.from("workforce_amazon_service_areas").select("service_area_id,service_area_name,station_code,station_state").eq("company_id", companyId).order("station_code"),
    supabaseAdmin.from("workforce_amazon_supervisor_defaults").select("supervisor_alias").eq("company_id", companyId).maybeSingle(),
    supabaseAdmin.from("workforce_amazon_supervisors").select("supervisor_alias,display_name,is_active").eq("company_id", companyId).eq("is_active", true).order("supervisor_alias"),
    supabaseAdmin.from("workforce_amazon_connections").select("username,enabled,version,updated_at,login_requested_at,login_attempted_at").eq("company_id", companyId).maybeSingle(),
    supabaseAdmin.from("workforce_amazon_sync_state").select("status,last_attempt_at,last_success_at,matched_count,missing_count").eq("company_id", companyId).maybeSingle()
  ]);
  const firstError = stationResult.error || settingResult.error || areaResult.error || defaultResult.error || supervisorResult.error || connectionResult.error || syncResult.error;
  const allStations = filterOnboardingLocations((stationResult.data ?? []) as Station[], authorization);
  const stations = allStations.filter((station) => String(relation(station.providers)?.name ?? "").toLowerCase().includes("amazon") && !/^TEST(?:\s|$)/i.test(station.station_code));
  const settings = (settingResult.data ?? []) as Setting[];
  const settingByStation = new Map(settings.map((setting) => [setting.station_id, setting]));
  const areas = (areaResult.data ?? []) as ServiceArea[];
  const areaByCode = new Map(areas.map((area) => [area.station_code.toUpperCase(), area]));
  const selectedStation = stations.find((station) => station.id === searchParams?.station) ?? stations[0] ?? null;
  const current = selectedStation ? settingByStation.get(selectedStation.id) ?? null : null;
  const defaultSupervisor = String(defaultResult.data?.supervisor_alias ?? "");
  const configured = stations.filter((station) => settingByStation.get(station.id)?.invitation_enabled).length;
  const unsynced = stations.filter((station) => !areaByCode.has(station.station_code.toUpperCase())).length;
  const connection = connectionResult.data;
  const sync = syncResult.data;

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
      <article><span>Invitation enabled</span><strong>{configured}</strong><small>{Math.max(0, stations.length - configured)} require setup</small></article>
      <article><span>Service area sync</span><strong>{Math.max(0, stations.length - unsynced)}</strong><small>{unsynced} station{unsynced === 1 ? "" : "s"} not yet synced</small></article>
      <article><span>LSC worker</span><strong>{connection?.enabled ? "Enabled" : "Setup required"}</strong><small>{sync?.status ? String(sync.status).replaceAll("_", " ") : "No worker check yet"}</small></article>
    </section>

    {authorization.hasAllLocationAccess && canEdit ? <section className="panel client-id-bulk-panel"><div className="panel-head"><div><h2>Shared station rollout</h2><p className="subtle">Enable unconfigured Amazon stations with the current shared supervisor badge. Existing enabled station overrides are preserved.</p></div><form action={enableMissingAmazonStations}><SubmitButton className="button" pendingText="Configuring stations" confirmMessage={`Enable all missing Amazon stations with supervisor ${defaultSupervisor || "the configured default"}?`} confirmTitle="Enable Amazon station invitations" confirmDescription="Synced service-area IDs will be mapped automatically. Every station remains editable below." disabled={!defaultSupervisor || configured === stations.length}>{configured === stations.length ? "All stations enabled" : "Enable missing stations"}</SubmitButton></form></div></section> : null}

    <div className="client-id-master-layout">
      <section className="panel client-id-station-list">
        <div className="panel-head"><div><h2>Stations</h2><p className="subtle">Choose a station to review or edit its setup.</p></div></div>
        <div className="client-id-station-links">{stations.map((station) => { const setting = settingByStation.get(station.id); const area = areaByCode.get(station.station_code.toUpperCase()); return <Link key={station.id} href={`/master/client-id?station=${station.id}`} className={selectedStation?.id === station.id ? "active" : ""}><span><strong>{station.station_code}</strong><small>{station.station_name || "Station name pending"}</small></span><span className={`status-pill ${setting?.invitation_enabled ? "good" : "warn"}`}>{setting?.invitation_enabled ? "Enabled" : "Setup"}</span>{!area ? <small className="client-id-sync-warning">Service area not synced</small> : null}</Link>; })}{!stations.length ? <div className="empty-state">No Amazon stations are available in your location scope.</div> : null}</div>
      </section>

      {selectedStation ? <section className="panel client-id-station-editor">
        <div className="panel-head"><div><p className="eyebrow">Station configuration</p><h2>{selectedStation.station_code} · {selectedStation.station_name || "Amazon station"}</h2><p className="subtle">These values are used when an OpsPulse user sends the client invitation.</p></div><span className={`status-pill ${current?.invitation_enabled ? "good" : "warn"}`}>{current?.invitation_enabled ? "Invitation enabled" : "Setup required"}</span></div>
        <form action={saveClientIdStation} className="form-grid two client-id-station-form">
          <input type="hidden" name="station_id" value={selectedStation.id}/>
          <input type="hidden" name="version" value={current?.version ?? 0}/>
          <label>Amazon service area<select className="field" name="amazon_service_area_id" defaultValue={current?.amazon_service_area_id || areaByCode.get(selectedStation.station_code.toUpperCase())?.service_area_id || ""}><option value="">Not synced / select later</option>{areas.map((area) => <option key={area.service_area_id} value={area.service_area_id}>{area.station_code} · {area.service_area_name}{area.station_state ? ` (${area.station_state})` : ""}</option>)}</select><small>Loaded from the Amazon service-area sync.</small></label>
          <label>Amazon service-area code<input className="field" name="service_area_code" required maxLength={24} defaultValue={current?.service_area_code || selectedStation.station_code}/></label>
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
      <div className="panel-head"><div><p className="eyebrow">Secure worker configuration</p><h2>Amazon LSC onboarding connection</h2><p className="subtle">The station master makes a request eligible. This encrypted connection lets the backend onboarding worker process the queued invitation.</p></div><span className={`status-pill ${connection?.enabled ? "good" : "warn"}`}>{connection?.enabled ? "Enabled" : "Not configured"}</span></div>
      {owner ? <form action={saveAmazonOnboardingConnection} className="form-grid two">
        <input name="version" type="hidden" value={connection?.version ?? 0}/>
        <label>Amazon LSC portal<input className="field" value="https://logistics.amazon.in" readOnly/></label>
        <label>Login email<input className="field" name="username" type="email" autoComplete="username" required defaultValue={connection?.username || ""}/></label>
        <label>Password<input className="field" name="password" type="password" autoComplete="new-password" required={!connection} placeholder={connection ? "Saved · leave blank to keep" : "Enter the Amazon login password"}/><small>Encrypted in Vault and never returned to this page.</small></label>
        <label className="checkbox-row"><input name="enabled" type="checkbox" defaultChecked={connection?.enabled ?? false}/> Enable onboarding worker connection</label>
        <div className="client-id-worker-health span-2"><span>Last worker check <b>{when(sync?.last_attempt_at)}</b></span><span>Last successful scan <b>{when(sync?.last_success_at)}</b></span><span>Last login attempt <b>{when(connection?.login_attempted_at)}</b></span><span>Latest scan <b>{sync?.matched_count ?? 0} matched · {sync?.missing_count ?? 0} missing</b></span></div>
        <div className="form-actions span-2"><SubmitButton disabled={!canEdit} pendingText="Saving securely">Save connection</SubmitButton><SubmitButton className="button secondary" disabled={!canEdit} pendingText="Requesting worker check" name="intent" value="test">Save & test connection</SubmitButton></div>
      </form> : <div className="panel-body"><p><strong>{connection?.enabled ? "Worker connection enabled" : "Owner setup required"}</strong></p><p className="subtle">Only the company owner can change the encrypted Amazon login. Station editors can still manage badge and service-area settings above.</p></div>}
    </section>
  </div></AppShell>;
}

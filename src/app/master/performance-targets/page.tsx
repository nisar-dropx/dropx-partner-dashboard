import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadPerformanceTargets, performanceTargetSeeds } from "@/lib/ops-pulse/performance-targets";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { addPerformanceMetric, removePerformanceMetric, updatePerformanceReviewCadence, updatePerformanceStationOpeningWindow, updatePerformanceTarget } from "./actions";

export const dynamic = "force-dynamic";
type SearchParams = { view?: string; saved?: string; opening_saved?: string; added?: string; deleted?: string; error?: string };

export default async function PerformanceTargetMaster({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("performance_master", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.performance_master;
  const view = searchParams?.view === "daily" ? "daily" : searchParams?.view === "reviews" ? "reviews" : "sls";
  const reportView = view === "daily" ? "daily" : "sls";
  const result = await loadPerformanceTargets(companyId);
  const rows = result.rows.filter((row) => row.reportType === reportView).sort((a, b) => a.displayOrder - b.displayOrder);
  const sourceType = view === "daily" ? "daily_edsp_metrics" : "edsp_sls_scorecard";
  const locationsResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const permittedLocations = locationsResult.locations;
  const [sourceResult, cadenceResult, openingResult] = supabaseAdmin
    ? await Promise.all([
      supabaseAdmin.from("report_metric_facts").select("values_json").eq("company_id", companyId).eq("source_type", sourceType).order("created_at", { ascending: false }).limit(50),
      supabaseAdmin.from("ops_performance_review_settings").select("daily_review_time,weekly_review_weekday,weekly_review_time,stale_after_hours").eq("company_id", companyId).maybeSingle(),
      permittedLocations.length ? supabaseAdmin.from("ops_performance_station_settings").select("station_id,opening_window_start,opening_window_end").eq("company_id", companyId).in("station_id", permittedLocations.map((location) => location.id)) : Promise.resolve({ data: [], error: null })
    ])
    : [{ data: [], error: null }, { data: null, error: null }, { data: [], error: null }];
  const openingByStation = new Map((openingResult.data ?? []).map((row) => [row.station_id, row]));
  const availableIndexes = new Set<number>();
  (sourceResult.data ?? []).forEach((fact) => {
    const value = fact.values_json;
    const values = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as { values?: unknown[] }).values)
        ? (value as { values: unknown[] }).values
        : [];
    values.forEach((_, index) => { if (index > 0) availableIndexes.add(index); });
  });
  const usedIndexes = new Set(rows.map((row) => row.sourceIndex).filter((index): index is number => index != null));
  const addOptions = [...availableIndexes].filter((index) => !usedIndexes.has(index)).sort((a, b) => a - b).map((index) => {
    const catalog = performanceTargetSeeds.find((row) => row.reportType === reportView && row.sourceIndex === index);
    return { index, label: catalog?.label ?? `Source field ${index}` };
  });
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  return <AppShell active="Performance Master" pageCode="performance_master"><div className="ops-command-center">
    <PageHead eyebrow="Ops Masters" title="Performance Master" subtitle="Choose which imported metrics are shown, then manage their targets and scoring." />
    <nav className="performance-tabs"><Link className={view === "sls" ? "active" : ""} href="/master/performance-targets?view=sls">Weekly SLS</Link><Link className={view === "daily" ? "active" : ""} href="/master/performance-targets?view=daily">Daily performance</Link><Link className={view === "reviews" ? "active" : ""} href="/master/performance-targets?view=reviews">Review cadence</Link></nav>
    {searchParams?.saved ? <section className="message-panel success">Metric updated.</section> : null}
    {searchParams?.opening_saved ? <section className="message-panel success">Station opening window updated.</section> : null}
    {searchParams?.added ? <section className="message-panel success">Metric added to Performance.</section> : null}
    {searchParams?.deleted ? <section className="message-panel success">Metric removed. Imported source data was preserved.</section> : null}
    {searchParams?.error || result.error ? <section className="message-panel error">{searchParams?.error || result.error}</section> : null}
    {view === "reviews" ? <div className="performance-review-master-grid"><section className="panel"><div className="panel-head"><div><h2>Review cadence</h2><p className="subtle">Set the daily and weekly review schedule. The reporting hierarchy supplies each approval layer.</p></div></div><form action={updatePerformanceReviewCadence} className="performance-review-cadence"><label>Daily review time<input type="time" name="daily_review_time" defaultValue={String(cadenceResult.data?.daily_review_time ?? "10:00").slice(0,5)}/></label><label>Weekly sales day<select name="weekly_review_weekday" defaultValue={Number(cadenceResult.data?.weekly_review_weekday ?? 4)}><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option></select></label><label>Weekly review time<input type="time" name="weekly_review_time" defaultValue={String(cadenceResult.data?.weekly_review_time ?? "16:00").slice(0,5)}/></label><label>Stuck after<input type="number" name="stale_after_hours" min="1" max="168" defaultValue={Number(cadenceResult.data?.stale_after_hours ?? 24)}/><small>Hours at the same review level</small></label><SubmitButton disabled={!permission.canEdit}>Save cadence</SubmitButton></form></section><section className="panel"><div className="panel-head"><div><h2>Station opening window</h2><p className="subtle">Station open is the first IN punch inside this window; overnight closing punches are ignored.</p></div></div><form action={updatePerformanceStationOpeningWindow} className="performance-opening-window-form"><label>Station<select name="station_id" required defaultValue=""><option disabled value="">Select station</option>{permittedLocations.map((location) => <option key={location.id} value={location.id}>{location.station_code} · {location.station_name || location.city || "Station"}</option>)}</select></label><label>From<input name="opening_window_start" type="time" defaultValue="02:00" required/></label><label>To<input name="opening_window_end" type="time" defaultValue="10:00" required/></label><SubmitButton disabled={!permission.canEdit || !permittedLocations.length}>Save window</SubmitButton></form><div className="performance-opening-window-list">{permittedLocations.map((location) => { const setting = openingByStation.get(location.id); return <span key={location.id}><b>{location.station_code}</b>{String(setting?.opening_window_start ?? "02:00").slice(0,5)}–{String(setting?.opening_window_end ?? "10:00").slice(0,5)}</span>; })}</div></section></div> : <><section className="performance-summary-grid"><article><span>Metrics</span><strong>{rows.length}</strong><small>{view === "sls" ? "Weekly SLS" : "Daily performance"}</small></article><article><span>Total weight</span><strong>{totalWeight}%</strong><small>{view === "sls" ? "Must total 100%" : "Informational targets"}</small></article><article><span>Mapped fields</span><strong>{rows.filter((row) => row.sourceIndex != null).length}</strong><small>Available in report</small></article><article><span>Unmapped</span><strong>{rows.filter((row) => row.sourceIndex == null).length}</strong><small>Awaiting source field</small></article></section>
    <section className="panel"><div className="panel-head"><div><h2>{view === "sls" ? "Weekly SLS metrics" : "Daily performance metrics"}</h2><p className="subtle">Add only fields detected in uploaded data. Removing a metric hides it from Performance but never deletes imported facts.</p></div>{addOptions.length ? <form action={addPerformanceMetric} className="performance-add-metric"><input type="hidden" name="report_type" value={reportView}/><input type="hidden" name="display_order" value={rows.length + 1}/><select name="source_index" required defaultValue=""><option value="" disabled>+ Add available metric</option>{addOptions.map((option) => <option key={option.index} value={option.index}>{option.label} · field {option.index}</option>)}</select><SubmitButton disabled={!permission.canAdd}>Add</SubmitButton></form> : <span className="status-pill good">All detected fields added</span>}</div><div className="table-wrap"><table className="performance-target-master"><thead><tr><th>Metric</th><th>Target</th><th>Direction</th><th>Weight</th><th>Unit</th><th>Source index</th><th>Status</th><th>Actions</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td colSpan={8}><div className="performance-target-row-wrap"><form action={updatePerformanceTarget} className="performance-target-row"><input type="hidden" name="id" value={row.id}/><input type="hidden" name="metric_key" value={row.metricKey}/><input type="hidden" name="report_type" value={row.reportType}/><input type="hidden" name="display_order" value={row.displayOrder}/><label><input name="label" defaultValue={row.label}/><input name="short" defaultValue={row.short}/></label><input name="target" type="number" step="any" defaultValue={row.target ?? ""}/><select name="direction" defaultValue={row.direction}><option value="higher">Higher is better</option><option value="lower">Lower is better</option></select><input name="weight" type="number" step="0.5" defaultValue={row.weight}/><select name="unit" defaultValue={row.unit}><option value="percent">Percent</option><option value="dpmo">DPMO</option><option value="ratio">Ratio to goal</option></select><input name="source_index" type="number" min="1" defaultValue={row.sourceIndex ?? ""}/><select name="is_active" defaultValue={String(row.isActive)}><option value="true">Active</option><option value="false">Inactive</option></select><SubmitButton disabled={!permission.canEdit}>Save</SubmitButton></form><form action={removePerformanceMetric}><input type="hidden" name="id" value={row.id}/><input type="hidden" name="report_type" value={row.reportType}/><SubmitButton className="button danger compact" confirmMessage={`Remove ${row.label} from Performance? Imported source data will remain available.`} confirmSubmitText="Delete metric" disabled={!permission.canEdit}>Delete</SubmitButton></form></div></td></tr>)}</tbody></table></div></section></>}
  </div></AppShell>;
}

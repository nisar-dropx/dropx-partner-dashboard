import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { CAPACITY_PLANNING_DEFAULTS, capacityPlanningSettings, loadCapacityRegionMaps, loadCapacityRules, loadCapacityServiceRoutes, loadShipmentSizeRule } from "@/lib/ops-pulse/capacity";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { bulkInitializeCapacityRules, importCapacityMapKml, removeCapacityRegionMap, removeCapacityRule, removeCapacityServiceRoute, upsertCapacityRegionMap, upsertCapacityRule, upsertCapacityServiceRoute, upsertShipmentSizeRule } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = { saved?: string; deleted?: string; initialized?: string; map_saved?: string; map_deleted?: string; size_saved?: string; route_saved?: string; route_deleted?: string; error?: string };

export default async function CapacityMasterPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("capacity_master", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.capacity_master;
  const [ruleResult, locationResult, mapResult, sizeResult, routeResult] = await Promise.all([
    loadCapacityRules(companyId),
    loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess),
    loadCapacityRegionMaps(companyId),
    loadShipmentSizeRule(companyId),
    loadCapacityServiceRoutes(companyId)
  ]);
  const capacityLocations = locationResult.locations.filter(isAmazonEdspXptLocation);
  const eligibleStationCodes = new Set(capacityLocations.map((location) => location.station_code));
  const capacityRules = ruleResult.rows.filter((rule) => eligibleStationCodes.has(rule.stationCode));
  const rules = new Map(capacityRules.map((row) => [row.stationCode, row]));

  return <AppShell active="Capacity Master" pageCode="capacity_master"><div className="ops-command-center">
    <PageHead eyebrow="Ops Masters" title="Capacity Master" subtitle="Station-level SPR, workload risk and workforce buffer assumptions. Nothing is hardcoded in Capacity." />
    {searchParams?.saved ? <div className="message-panel success">Capacity rule saved.</div> : null}
    {searchParams?.initialized ? <div className="message-panel success">{searchParams.initialized} station capacity rules initialized.</div> : null}
    {searchParams?.deleted ? <div className="message-panel success">Capacity rule deleted. The station will remain visible as Not configured.</div> : null}
    {searchParams?.map_saved ? <div className="message-panel success">Capacity map saved.</div> : null}
    {searchParams?.map_deleted ? <div className="message-panel success">Capacity map deleted.</div> : null}
    {searchParams?.size_saved ? <div className="message-panel success">Shipment-size classification saved.</div> : null}
    {searchParams?.route_saved ? <div className="message-panel success">Service route saved.</div> : null}
    {searchParams?.route_deleted ? <div className="message-panel success">Service route deleted.</div> : null}
    {searchParams?.error || ruleResult.error || locationResult.error || mapResult.error || sizeResult.error || routeResult.error ? <div className="message-panel error">{searchParams?.error || ruleResult.error || locationResult.error || mapResult.error || sizeResult.error || routeResult.error}</div> : null}
    <section className="performance-summary-grid">
      <article><span>Stations</span><strong>{capacityLocations.length}</strong><small>Amazon EDSP / XPT only</small></article>
      <article><span>Configured</span><strong>{capacityRules.length}</strong><small>Ready for planning</small></article>
      <article><span>Pending</span><strong>{Math.max(0, capacityLocations.length - capacityRules.length)}</strong><small>Require assumptions</small></article>
      <article><span>Model</span><strong>Station level</strong><small>Editable independently</small></article>
    </section>
    <section className="panel capacity-bulk-panel"><div className="panel-head"><div><h2>Hiring decision defaults</h2><p className="subtle">Apply the same baseline, minimum source coverage and alert thresholds to every permitted station.</p></div></div><form action={bulkInitializeCapacityRules} className="capacity-bulk-form capacity-bulk-planning-form"><label>Target SPR<input name="target_spr" type="number" min="1" step=".1" defaultValue="40" required/></label><label>Safe SPR<input name="max_safe_spr" type="number" min="1" step=".1" defaultValue="70" required/></label><label>Buffer %<input name="buffer_percent" type="number" min="0" step=".5" defaultValue="10" required/></label><label>Baseline days<input name="recent_days" type="number" min="14" max="31" defaultValue={CAPACITY_PLANNING_DEFAULTS.baselineDays} required/></label><label>Min source days<input name="minimum_source_days" type="number" min="1" max="31" defaultValue={CAPACITY_PLANNING_DEFAULTS.minimumSourceDays} required/></label><label>DA drop alert %<input name="associate_drop_percent" type="number" min="1" max="100" defaultValue={CAPACITY_PLANNING_DEFAULTS.associateDropPercent} required/></label><label>Volume spike %<input name="volume_spike_percent" type="number" min="1" max="300" defaultValue={CAPACITY_PLANNING_DEFAULTS.volumeSpikePercent} required/></label><SubmitButton confirmMessage="Apply these assumptions to every Amazon EDSP and XPT station?" confirmTitle="Initialize Amazon capacity rules" confirmSubmitText="Apply to all" disabled={!permission.canEdit}>Apply to all stations</SubmitButton></form></section>
    <section className="panel capacity-bulk-panel"><div className="panel-head"><div><h2>Shipment and active-day rules</h2><p className="subtle">Operational volumetric = beyond the standard parcel dimensions, actual weight above the limit, or dimensional weight above the limit. Dimensional weight = L×W×H ÷ divisor. “Minimum active deliveries” excludes tiny test/assist ID-days from headcount and SPR.</p></div><form action={upsertShipmentSizeRule} className="capacity-bulk-form"><label>Max length cm<input name="max_length_cm" type="number" min="1" step=".1" defaultValue={sizeResult.rule?.maxLengthCm ?? 46} required/></label><label>Max width cm<input name="max_width_cm" type="number" min="1" step=".1" defaultValue={sizeResult.rule?.maxWidthCm ?? 36} required/></label><label>Max height cm<input name="max_height_cm" type="number" min="1" step=".1" defaultValue={sizeResult.rule?.maxHeightCm ?? 20} required/></label><label>Actual weight kg<input name="max_weight_kg" type="number" min=".1" step=".1" defaultValue={sizeResult.rule?.maxWeightKg ?? 5} required/></label><label>Dimensional divisor<input name="dimensional_divisor" type="number" min="1" step="1" defaultValue={sizeResult.rule?.dimensionalDivisor ?? 5000} required/></label><label>Dimensional weight kg<input name="max_dimensional_weight_kg" type="number" min=".1" step=".1" defaultValue={sizeResult.rule?.maxDimensionalWeightKg ?? 5} required/></label><label>Minimum active deliveries<input name="min_active_shipments" type="number" min="1" step="1" defaultValue={sizeResult.rule?.minActiveShipments ?? 5} required/></label><SubmitButton disabled={!permission.canEdit}>Save rules</SubmitButton></form></div></section>
    <section className="panel"><div className="panel-head"><div><h2>Optional service-area overlay</h2><p className="subtle">The Google service-area map remains unchanged. Add coordinates only when an approved pincode/vehicle overlay is available; individual DA stops are not required.</p></div></div>
      <form action={upsertCapacityServiceRoute} className="capacity-map-master-form"><label>Station<select name="station_code" required><option value="">Select station</option>{capacityLocations.map((location) => <option key={location.id} value={location.station_code}>{location.station_code} · {location.station_name || location.city}</option>)}</select></label><label>Route name<input name="route_name" placeholder="North route 01" required/></label><label>Vehicle<select name="vehicle_type" required><option value="bike">Bike</option><option value="van">Van</option></select></label><label>Pincode<input name="pincode" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" placeholder="524101" required/></label><label>DA ID<input name="da_id" placeholder="A1..." required/></label><label>DA name<input name="da_name" placeholder="Associate name"/></label><label>Route colour<input name="color" type="color" defaultValue="#ea580c"/></label><label className="wide">Ordered coordinates<textarea name="coordinates" rows={5} placeholder={"14.1467,79.8500\n14.1621,79.8725\n14.1810,79.9012"} required/></label><SubmitButton disabled={!permission.canEdit}>Add route</SubmitButton></form>
      <div className="table-wrap"><table><thead><tr><th>Station</th><th>Route</th><th>Vehicle</th><th>Pincode</th><th>DA</th><th>Points</th><th>Action</th></tr></thead><tbody>{routeResult.rows.map((route) => <tr key={route.id}><td><strong>{route.stationCode}</strong></td><td>{route.routeName}</td><td><span className={`status-pill ${route.vehicleType === "van" ? "neutral" : "warn"}`}>{route.vehicleType}</span></td><td>{route.pincode}</td><td>{route.daName || "—"}<small>{route.daId}</small></td><td>{route.coordinates.length}</td><td><form action={removeCapacityServiceRoute}><input type="hidden" name="id" value={route.id}/><SubmitButton className="button danger compact" confirmMessage={`Delete ${route.routeName}?`} confirmSubmitText="Delete route" disabled={!permission.canEdit}>Delete</SubmitButton></form></td></tr>)}{!routeResult.rows.length ? <tr><td className="empty-cell" colSpan={7}>No internal service routes configured yet.</td></tr> : null}</tbody></table></div>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Region Map Master</h2><p className="subtle">Attach a Google My Map to a station, region or state. Capacity resolves the map from location master data.</p></div></div>
      <form action={upsertCapacityRegionMap} className="capacity-map-master-form"><label>Map name<input name="name" placeholder="AP Region Capacity Map" required/></label><label>Match by<select name="match_field" defaultValue="region"><option value="station">Station code</option><option value="region">Region</option><option value="state">State</option></select></label><label>Match value<input name="match_value" placeholder="AP" required/></label><label className="wide">Google My Maps URL<input name="map_url" type="url" placeholder="https://www.google.com/maps/d/edit?mid=..." required/></label><SubmitButton disabled={!permission.canEdit}>Add map</SubmitButton></form>
      <div className="table-wrap"><table><thead><tr><th>Name</th><th>Match</th><th>Map</th><th>Action</th></tr></thead><tbody>{mapResult.rows.map((map) => <tr key={map.id}><td><strong>{map.name}</strong></td><td>{map.matchField} · {map.matchValue}</td><td><a href={map.mapUrl} target="_blank" rel="noreferrer">Open map</a></td><td><form action={removeCapacityRegionMap}><input type="hidden" name="id" value={map.id}/><SubmitButton className="button danger compact" confirmMessage={`Delete ${map.name}?`} confirmSubmitText="Delete map" disabled={!permission.canEdit}>Delete</SubmitButton></form></td></tr>)}{!mapResult.rows.length ? <tr><td className="empty-cell" colSpan={4}>No capacity maps configured.</td></tr> : null}</tbody></table></div>
      <form action={importCapacityMapKml} className="capacity-map-master-form"><label className="wide">Private/restricted My Map URL<input name="map_url" type="url" placeholder="https://www.google.com/maps/d/edit?mid=..." required/></label><label className="wide">KML layer export<input name="kml_file" type="file" accept=".kml,application/vnd.google-earth.kml+xml" required/></label><SubmitButton disabled={!permission.canEdit}>Import station layers</SubmitButton></form>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Station planning rules</h2><p className="subtle">Baseline and minimum source days control decision confidence; alert percentages control dashboard notifications.</p></div></div>
      <div className="table-wrap"><table className="capacity-master-table capacity-master-planning-table"><thead><tr><th>Station</th><th>Target SPR</th><th>Safe SPR</th><th>Buffer %</th><th>Baseline days</th><th>Min source</th><th>DA drop %</th><th>Volume spike %</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {capacityLocations.map((location) => {
          const rule = rules.get(location.station_code);
          const settings = capacityPlanningSettings(rule);
          const formId = `capacity-rule-${location.id}`;
          return <tr key={location.id}>
            <td><form action={upsertCapacityRule} id={formId}><input name="station_code" type="hidden" value={location.station_code}/></form><strong>{location.station_code}</strong><small>{location.station_name || location.city || "—"}</small></td>
            <td><input aria-label={`${location.station_code} target SPR`} form={formId} name="target_spr" type="number" min="1" step=".1" defaultValue={rule?.targetSpr ?? 40} required/></td>
            <td><input aria-label={`${location.station_code} safe SPR`} form={formId} name="max_safe_spr" type="number" min="1" step=".1" defaultValue={rule?.maxSafeSpr ?? 70} required/></td>
            <td><input aria-label={`${location.station_code} buffer percent`} form={formId} name="buffer_percent" type="number" min="0" step=".5" defaultValue={rule?.bufferPercent ?? 10} required/></td>
            <td><input aria-label={`${location.station_code} baseline days`} form={formId} name="recent_days" type="number" min="14" max="31" defaultValue={settings.baselineDays} required/></td>
            <td><input aria-label={`${location.station_code} minimum source days`} form={formId} name="minimum_source_days" type="number" min="1" max="31" defaultValue={settings.minimumSourceDays} required/></td>
            <td><input aria-label={`${location.station_code} associate drop alert percent`} form={formId} name="associate_drop_percent" type="number" min="1" max="100" defaultValue={settings.associateDropPercent} required/></td>
            <td><input aria-label={`${location.station_code} volume spike alert percent`} form={formId} name="volume_spike_percent" type="number" min="1" max="300" defaultValue={settings.volumeSpikePercent} required/></td>
            <td><span className={`status-pill ${rule ? "good" : "warn"}`}>{rule ? "Configured" : "Pending"}</span></td>
            <td><div className="capacity-master-actions"><SubmitButton form={formId} disabled={!permission.canEdit}>{rule ? "Save" : "Configure"}</SubmitButton>{rule?.id ? <form action={removeCapacityRule}><input type="hidden" name="id" value={rule.id}/><SubmitButton className="button danger compact" confirmMessage={`Delete capacity assumptions for ${location.station_code}?`} confirmSubmitText="Delete rule" disabled={!permission.canEdit}>Delete</SubmitButton></form> : null}</div></td>
          </tr>;
        })}
      </tbody></table></div>
    </section>
  </div></AppShell>;
}

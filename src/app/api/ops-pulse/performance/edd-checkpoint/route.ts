import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { EDD_MOVEMENT_GROUPS, eddCheckpointExportRows, selectEddCheckpointPackages, type EddCheckpointPackage } from "@/lib/ops-pulse/edd-movement";
import { compressedWorkbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "performance_review", "access"))
    return Response.json({ error: "Review access required." }, { status: 403, headers });
  const p = new URL(request.url).searchParams;
  const stationCode = p.get("station") || "", day = p.get("date") || "", observedAt = p.get("observedAt") || "", group = p.get("group") || "all";
  if (!/^[A-Z0-9_-]{1,30}$/.test(stationCode) || !/^\d{4}-\d{2}-\d{2}$/.test(day)
    || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day
    || !Number.isFinite(Date.parse(observedAt)) || !["all", "pending", "unmapped", ...EDD_MOVEMENT_GROUPS.map(([key]) => key)].includes(group))
    return Response.json({ error: "Choose a valid checkpoint." }, { status: 400, headers });
  try {
    if (!supabaseAdmin) throw Error("Database unavailable");
    const companyId = requireCompanyId(auth);
    const scope = await loadCodLocations(companyId, auth.locationScopeIds, auth.hasAllLocationAccess);
    if (scope.error) throw Error("Scope unavailable");
    const station = scope.locations.find(row => row.station_code === stationCode);
    if (!station) return Response.json({ error: "Station access required." }, { status: 403, headers });
    const { data, error } = await supabaseAdmin.from("ops_review_edd_observations")
      .select("observed_at,package_details,counts")
      .eq("company_id", companyId).eq("station_id", station.id).eq("work_date", day)
      .eq("observed_at", new Date(observedAt).toISOString()).maybeSingle();
    if (error) throw error;
    if (!data || !Array.isArray(data.package_details) || !data.counts?.packageDetailsRecorded)
      return Response.json({ error: "This historical checkpoint saved totals only. Its tracking-ID list was not recorded; current parcels will not be substituted." }, { status: 409, headers });
    const details = data.package_details as EddCheckpointPackage[];
    if (data.counts.movement?.total !== details.length) throw Error("Checkpoint evidence does not reconcile");
    const states = (p.get("statuses") || "").split(",").filter(Boolean);
    const rows = selectEddCheckpointPackages(details, group, (p.get("query") || "").slice(0,150))
      .filter(row => !states.length || states.includes(row[1]));
    if (p.get("format") === "xlsx") return compressedWorkbookResponse([
      { name: "Checkpoint TIDs", rows: eddCheckpointExportRows(rows, stationCode, day, data.observed_at) },
      { name: "Selection", rows: [{ Station: stationCode, "EDD date": day, "Observation UTC": data.observed_at,
        Group: group, Statuses: states.join(", ") || "All source statuses", "Tracking IDs": rows.length,
        Note: "Status and membership are frozen at this checkpoint. A live tracking lookup may show a later status. At station includes returned parcels; Fresh EDD pending excludes prior dispatch or attempts." }] }
    ], `edd-${stationCode}-${day}-${new Date(observedAt).toISOString().slice(11,16).replace(":", "")}-${group}.xlsx`);
    const page = Math.max(1, Math.min(10000, Math.floor(Number(p.get("page")) || 1)));
    return Response.json({ observedAt: data.observed_at, total: rows.length, page,
      statuses: [...new Set(selectEddCheckpointPackages(details, group).map(row => row[1]))].sort(),
      rows: rows.slice((page-1)*100, page*100) }, { headers });
  } catch { return Response.json({ error: "Checkpoint details could not be loaded. Please retry." }, { status: 503, headers }); }
}


import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadShipmentSizeRule } from "@/lib/ops-pulse/capacity";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type SearchParams = { station?: string; associate?: string; pincode?: string; size?: string; from?: string; to?: string };
type Fact = {
  tracking_id: string; work_date: string; station_code: string; driver_id: string; driver_name: string | null;
  postal_code: string; actual_weight_kg: number | string | null; length_cm: number | string | null;
  width_cm: number | string | null; height_cm: number | string | null;
};
function validDate(value: unknown) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")); }
function n(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }

export default async function CapacityShipmentEvidencePage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("capacity_delivery", "access");
  const companyId = requireCompanyId(authorization);
  const locations = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const allowedCodes = new Set(locations.locations.map((row) => row.station_code));
  const station = String(searchParams?.station ?? "").trim().toUpperCase();
  const from = validDate(searchParams?.from) ? String(searchParams?.from) : "";
  const to = validDate(searchParams?.to) ? String(searchParams?.to) : "";
  const associate = String(searchParams?.associate ?? "").trim();
  const pincode = String(searchParams?.pincode ?? "").trim();
  const size = ["volumetric", "small"].includes(String(searchParams?.size)) ? String(searchParams?.size) : "";
  const sizeResult = await loadShipmentSizeRule(companyId);
  const rule = sizeResult.rule;
  let query = supabaseAdmin?.from("delivered_shipment_facts")
    .select("tracking_id,work_date,station_code,driver_id,driver_name,postal_code,actual_weight_kg,length_cm,width_cm,height_cm")
    .eq("company_id", companyId).eq("station_code", station).order("work_date", { ascending: false }).limit(1000);
  if (!allowedCodes.has(station)) query = undefined;
  if (query && from) query = query.gte("work_date", from);
  if (query && to) query = query.lte("work_date", to);
  if (query && associate) query = query.eq("driver_id", associate);
  if (query && pincode) query = query.eq("postal_code", pincode);
  const result = query ? await query : { data: [] as Fact[], error: null };
  const classified = ((result.data ?? []) as Fact[]).map((row) => {
    const weight = n(row.actual_weight_kg), length = n(row.length_cm), width = n(row.width_cm), height = n(row.height_cm);
    const complete = weight != null && length != null && width != null && height != null && rule;
    const dimensionalWeight = complete ? length! * width! * height! / (rule!.dimensionalDivisor || 5000) : null;
    const volumetric = Boolean(complete && (weight! > rule!.maxWeightKg || length! > rule!.maxLengthCm || width! > rule!.maxWidthCm || height! > rule!.maxHeightCm || dimensionalWeight! > (rule!.maxDimensionalWeightKg || 5)));
    return { ...row, classification: !complete ? "Unclassified" : volumetric ? "Volumetric" : "Small" };
  }).filter((row) => !size || row.classification.toLowerCase() === size);

  return <AppShell active="Capacity" pageCode="capacity_delivery"><div className="ops-command-center capacity-workspace">
    <PageHead eyebrow="Shipment evidence" title={`${station || "Station"} tracking IDs`} subtitle="Tracking-level evidence behind capacity and shipment-size metrics." />
    <div className="capacity-station-toolbar"><a className="button secondary compact" href={`/ops-pulse/capacity/${station}?from=${from}&to=${to}`}>← Station capacity</a><span className="status-pill neutral">{classified.length}{(result.data?.length ?? 0) >= 1000 ? "+" : ""} rows</span></div>
    {result.error || sizeResult.error ? <div className="message-panel error">{result.error?.message || sizeResult.error}</div> : null}
    <section className="panel"><div className="panel-head"><div><h2>Applied evidence</h2><p className="subtle">{from || "All dates"} to {to || "latest"}{pincode ? ` · pincode ${pincode}` : ""}{associate ? ` · ID ${associate}` : ""}{size ? ` · ${size}` : ""}</p></div></div>
      <div className="table-wrap"><ReportTable className="capacity-daily-table"><thead><tr><th>Date</th><th>Tracking ID</th><th>Associate</th><th>Pincode</th><th>Weight</th><th>Dimensions cm</th><th>Classification</th></tr></thead><tbody>
        {classified.map((row) => <tr key={row.tracking_id}><td>{row.work_date.split("-").reverse().join("/")}</td><td><strong>{row.tracking_id}</strong></td><td>{row.driver_name || "—"}<small>{row.driver_id}</small></td><td>{row.postal_code}</td><td>{row.actual_weight_kg == null ? "—" : `${row.actual_weight_kg} kg`}</td><td>{row.length_cm ?? "—"} × {row.width_cm ?? "—"} × {row.height_cm ?? "—"}</td><td><span className={`capacity-decision ${row.classification === "Volumetric" ? "risk" : row.classification === "Small" ? "balanced" : "unconfigured"}`}>{row.classification}</span></td></tr>)}
        {!classified.length ? <tr><td className="empty-cell" colSpan={7}>No tracking IDs match this selection.</td></tr> : null}
      </tbody></ReportTable></div>
    </section>
  </div></AppShell>;
}

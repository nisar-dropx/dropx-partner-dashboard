import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { loadOpsStationManpower } from "@/lib/ops-pulse/station-manpower";
import { shiftAttendanceWorkbook, shiftExportResponse } from "@/lib/shift-attendance-export";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || auth.readOnly || !hasPermission(auth, "ops_pulse", "access") || !hasPermission(auth, "ops_reports", "access"))
    return Response.json({ error: "OpsPulse and Reports access are required." }, { status: 403 });
  const q = new URL(request.url).searchParams, date = q.get("date") ?? "", locationId = q.get("location") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || !locationId)
    return Response.json({ error: "Select a date and location." }, { status: 400 });
  try {
    const companyId = requireCompanyId(auth);
    const locations = await loadCodLocations(companyId, auth.locationScopeIds, auth.hasAllLocationAccess);
    if (locations.error) throw new Error(locations.error);
    const selected = locations.locations.filter(l => l.id === locationId);
    if (!selected.length) return Response.json({ error: "Location access denied." }, { status: 403 });
    const data = await loadOpsStationManpower(companyId, selected, date);
    return shiftExportResponse(shiftAttendanceWorkbook(data.people, date, new Map(selected.map(l => [l.id, l.station_code])), q.get("status") ?? "all", q.get("search") ?? ""), date);
  } catch (error) {
    console.error("Shift attendance export failed", error);
    return Response.json({ error: "Unable to download shift attendance. Please retry." }, { status: 503 });
  }
}

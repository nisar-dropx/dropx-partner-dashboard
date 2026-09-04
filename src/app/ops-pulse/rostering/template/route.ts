import * as XLSX from "xlsx";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { recurringRosterDays } from "@/lib/ops-pulse/recurring-roster-import";
import { canUseRosterLocation, indiaToday, loadOpsRosterCapabilities, rosterMonday } from "@/lib/ops-pulse/rostering";
import { loadOpsStationManpower } from "@/lib/ops-pulse/station-manpower";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeFilename(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "roster";
}

function isoWeekday(value: string) {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function db() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}

export async function GET(request: Request) {
  try {
    const authorization = await requirePagePermission("ops_rostering", "add");
    const companyId = requireCompanyId(authorization);
    const capabilities = await loadOpsRosterCapabilities(authorization);
    if (!capabilities.canPlan) return Response.json({ error: "Your designation is not authorised to plan rosters." }, { status: 403 });
    if (!hasPermission(authorization, "ops_rostering", "add") && !hasPermission(authorization, "ops_rostering", "edit")) {
      return Response.json({ error: "Roster planner access is required." }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;
    const stationId = params.get("station")?.trim() ?? "";
    const planId = params.get("plan")?.trim() ?? "";
    if (!stationId) return Response.json({ error: "Select a station first." }, { status: 400 });
    if (!canUseRosterLocation(authorization, stationId)) {
      return Response.json({ error: "This station is outside your OpsPulse location access." }, { status: 403 });
    }

    const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
    const station = locationResult.locations.find((location) => location.id === stationId);
    if (!station) return Response.json({ error: "This station is not available." }, { status: 404 });

    const today = indiaToday();
    const [manpower, shiftsResult] = await Promise.all([
      loadOpsStationManpower(companyId, [station], today),
      db().from("hr_shifts").select("id,code,name,start_time,end_time").eq("company_id", companyId).eq("is_active", true).order("start_time")
    ]);
    if (shiftsResult.error) throw new Error(shiftsResult.error.message);

    let periodStart = rosterMonday(today);
    let sourceEntries: Array<{ worker_type: string; worker_id: string; roster_date: string; day_type: string; shift_id: string | null }> = [];

    if (planId) {
      const plan = await db().from("hr_roster_plans")
        .select("id,location_id,period_start,status,hr_roster_entries(worker_type,worker_id,roster_date,day_type,shift_id)")
        .eq("company_id", companyId)
        .eq("id", planId)
        .maybeSingle();
      if (plan.error) throw new Error(plan.error.message);
      if (!plan.data || plan.data.location_id !== stationId) {
        return Response.json({ error: "Roster plan not found for this station." }, { status: 404 });
      }
      periodStart = plan.data.period_start;
      sourceEntries = plan.data.hr_roster_entries ?? [];
    } else {
      const approved = await db().from("hr_roster_plans")
        .select("id,period_start,hr_roster_entries(worker_type,worker_id,roster_date,day_type,shift_id)")
        .eq("company_id", companyId)
        .eq("location_id", stationId)
        .eq("roster_kind", "recurring_weekly")
        .eq("status", "approved")
        .is("superseded_at", null)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (approved.error) throw new Error(approved.error.message);
      if (approved.data) {
        periodStart = approved.data.period_start;
        sourceEntries = approved.data.hr_roster_entries ?? [];
      }
    }

    const shiftById = new Map((shiftsResult.data ?? []).map((shift) => [shift.id, shift]));
    const valueByPersonDay = new Map<string, string>();
    for (const entry of sourceEntries) {
      const shift = entry.shift_id ? shiftById.get(entry.shift_id) : null;
      valueByPersonDay.set(
        `${entry.worker_type}:${entry.worker_id}:${isoWeekday(entry.roster_date)}`,
        entry.day_type === "weekly_off" ? "WO" : shift?.code ?? ""
      );
    }

    const rows = manpower.people.map((person) => ({
      LOCATION_CODE: station.station_code,
      DROPX_ID: person.code,
      NAME: person.name,
      PEOPLE_TYPE: person.workerType === "employee" ? "Employee" : "Independent Contractor",
      DESIGNATION: person.designation,
      ...Object.fromEntries(recurringRosterDays.map((day, index) => [
        day,
        valueByPersonDay.get(`${person.workerType}:${person.id}:${index + 1}`) ?? ""
      ]))
    }));

    const headers = ["LOCATION_CODE", "DROPX_ID", "NAME", "PEOPLE_TYPE", "DESIGNATION", ...recurringRosterDays];
    const rosterSheet = XLSX.utils.json_to_sheet(rows, { header: headers });
    rosterSheet["!cols"] = [{ wch: 16 }, { wch: 16 }, { wch: 28 }, { wch: 22 }, { wch: 28 }, ...recurringRosterDays.map(() => ({ wch: 16 }))];
    const shiftSheet = XLSX.utils.json_to_sheet((shiftsResult.data ?? []).map((shift) => ({
      SHIFT_CODE: shift.code,
      SHIFT_NAME: shift.name,
      START_TIME: String(shift.start_time).slice(0, 5),
      END_TIME: String(shift.end_time).slice(0, 5)
    })));
    shiftSheet["!cols"] = [{ wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 14 }];
    const instructions = XLSX.utils.aoa_to_sheet([
      ["DropX Ops station recurring roster"],
      ["Station", station.station_code],
      ["Template week starts", periodStart],
      ["Active people", String(rows.length)],
      [],
      ["How to complete"],
      ["1", "Each person appears once with Monday to Sunday in the same row."],
      ["2", "Enter a SHIFT_CODE from the Shift Master tab for working days."],
      ["3", "Enter WO for a weekly off. Leave a cell blank to clear that day."],
      ["4", "Do not change LOCATION_CODE or DROPX_ID. Only people at this station are accepted."],
      ["5", "Upload into an editable Ops draft. Import never publishes — submit for approval after import."],
      ["6", "Approval route: station owner → reporting manager → HR."]
    ]);
    instructions["!cols"] = [{ wch: 16 }, { wch: 100 }];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, rosterSheet, "Recurring Roster");
    XLSX.utils.book_append_sheet(workbook, shiftSheet, "Shift Master");
    XLSX.utils.book_append_sheet(workbook, instructions, "Instructions");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${safeFilename(station.station_code)}-recurring-roster.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to generate the roster template." }, { status: 500 });
  }
}

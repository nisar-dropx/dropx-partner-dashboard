import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext, operatingModeForLocation } from "@/lib/ops-pulse/operating-context";
import {
  buildRecurringRosterWorkbook,
  safeRosterFilename,
  type RosterTemplateEntry,
  type RosterTemplateStationPeriod
} from "@/lib/ops-pulse/roster-template-export";
import { canUseRosterLocation, indiaToday, rosterMonday } from "@/lib/ops-pulse/rostering";
import { loadOpsStationManpower } from "@/lib/ops-pulse/station-manpower";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

function db() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}

async function allPlanRows<T>(
  query: (offset: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const result = await query(offset);
    if (result.error) throw new Error(result.error.message);
    rows.push(...((result.data ?? []) as T[]));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw new Error("Roster export exceeds the download limit.");
}

export async function GET(request: Request) {
  try {
    const authorization = await requirePagePermission("ops_rostering", "access");
    const companyId = requireCompanyId(authorization);
    if (!hasPermission(authorization, "ops_rostering", "access")) {
      return Response.json({ error: "Roster access is required." }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;
    const downloadAll = params.get("all") === "1" || params.get("scope") === "all";
    const stationId = params.get("station")?.trim() ?? "";
    const planId = params.get("plan")?.trim() ?? "";
    if (!downloadAll && !stationId) {
      return Response.json({ error: "Select a station, or use all=1 to download every station in your scope." }, { status: 400 });
    }
    if (downloadAll && planId) {
      return Response.json({ error: "A specific plan can only be downloaded for one station." }, { status: 400 });
    }

    const locationResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
    if (locationResult.error) throw new Error(locationResult.error);
    const ds = resolveOperatingContext(locationResult.locations).mode === "amazon_now";
    const scoped = locationResult.locations.filter((location) =>
      !location.hide_from_location_list &&
      !location.is_ho &&
      (operatingModeForLocation(location) === "amazon_now") === ds &&
      canUseRosterLocation(authorization, location.id)
    );

    const stations = downloadAll
      ? scoped
      : scoped.filter((location) => location.id === stationId);
    if (!stations.length) {
      return Response.json({
        error: downloadAll
          ? "No stations are available in your OpsPulse location scope."
          : "This station is outside your OpsPulse location access."
      }, { status: downloadAll ? 404 : 403 });
    }
    if (!downloadAll && !scoped.some((location) => location.id === stationId)) {
      return Response.json({ error: "This station is outside your OpsPulse location access." }, { status: 403 });
    }

    const today = indiaToday();
    const fallbackPeriodStart = rosterMonday(today);
    const [manpower, shiftsResult] = await Promise.all([
      loadOpsStationManpower(companyId, stations, today),
      db().from("hr_shifts").select("id,code,name,start_time,end_time").eq("company_id", companyId).eq("is_active", true).order("start_time")
    ]);
    if (shiftsResult.error) throw new Error(shiftsResult.error.message);

    const periods: RosterTemplateStationPeriod[] = [];
    const entries: RosterTemplateEntry[] = [];

    if (!downloadAll && planId) {
      const plan = await db().from("hr_roster_plans")
        .select("id,location_id,period_start,hr_roster_entries(worker_type,worker_id,roster_date,day_type,shift_id)")
        .eq("company_id", companyId)
        .eq("id", planId)
        .maybeSingle();
      if (plan.error) throw new Error(plan.error.message);
      if (!plan.data || plan.data.location_id !== stations[0].id) {
        return Response.json({ error: "Roster plan not found for this station." }, { status: 404 });
      }
      periods.push({ stationId: stations[0].id, periodStart: plan.data.period_start });
      for (const entry of plan.data.hr_roster_entries ?? []) {
        entries.push({ ...entry, location_id: stations[0].id });
      }
    } else {
      type ApprovedPlan = {
        id: string;
        location_id: string;
        period_start: string;
        effective_from: string | null;
        hr_roster_entries: Array<{ worker_type: string; worker_id: string; roster_date: string; day_type: string; shift_id: string | null }> | null;
      };
      const stationIds = stations.map((station) => station.id);
      const approved: ApprovedPlan[] = [];
      // Keep PostgREST `in()` URLs short for wide location scopes.
      for (let index = 0; index < stationIds.length; index += 80) {
        const chunk = stationIds.slice(index, index + 80);
        const chunkRows = await allPlanRows<ApprovedPlan>((offset) =>
          db().from("hr_roster_plans")
            .select("id,location_id,period_start,effective_from,hr_roster_entries(worker_type,worker_id,roster_date,day_type,shift_id)")
            .eq("company_id", companyId)
            .in("location_id", chunk)
            .eq("roster_kind", "recurring_weekly")
            .eq("status", "approved")
            .is("superseded_at", null)
            .order("effective_from", { ascending: false })
            .order("id", { ascending: false })
            .range(offset, offset + 999)
        );
        approved.push(...chunkRows);
      }

      const latestByStation = new Map<string, ApprovedPlan>();
      for (const plan of approved) {
        const current = latestByStation.get(plan.location_id);
        if (!current) {
          latestByStation.set(plan.location_id, plan);
          continue;
        }
        const currentFrom = current.effective_from || current.period_start;
        const nextFrom = plan.effective_from || plan.period_start;
        if (nextFrom > currentFrom || (nextFrom === currentFrom && plan.id > current.id)) {
          latestByStation.set(plan.location_id, plan);
        }
      }
      for (const station of stations) {
        const plan = latestByStation.get(station.id);
        periods.push({ stationId: station.id, periodStart: plan?.period_start || fallbackPeriodStart });
        for (const entry of plan?.hr_roster_entries ?? []) {
          entries.push({ ...entry, location_id: station.id });
        }
      }
    }

    const bytes = buildRecurringRosterWorkbook({
      stations: stations.map((station) => ({
        id: station.id,
        station_code: station.station_code,
        station_name: station.station_name
      })),
      people: manpower.people.map((person) => ({
        id: person.id,
        workerType: person.workerType,
        code: person.code,
        name: person.name,
        designation: person.designation,
        locationId: person.locationId
      })),
      shifts: (shiftsResult.data ?? []).map((shift) => ({
        id: shift.id,
        code: shift.code,
        name: shift.name,
        start_time: String(shift.start_time),
        end_time: String(shift.end_time)
      })),
      entries,
      periods,
      today,
      fallbackPeriodStart
    });

    const filename = downloadAll
      ? `all-stations-recurring-roster-${today}.xlsx`
      : `${safeRosterFilename(stations[0].station_code)}-recurring-roster.xlsx`;

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to generate the roster template." }, { status: 500 });
  }
}

import { getAuthorization } from "@/lib/authorization";
import { FleetReportError, reportScope } from "@/lib/fleet/report-data";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";

export const dynamic = "force-dynamic";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  if (!supabaseAdmin) return Response.json({ error: "Fleet data is temporarily unavailable." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const vehicleNo = String(params.get("vehicle_no") ?? "").trim().toUpperCase();
  const from = String(params.get("from") ?? "");
  const to = String(params.get("to") ?? "");
  if (!vehicleNo || !DATE.test(from) || !DATE.test(to) || from > to) return Response.json({ error: "Choose a vehicle and a valid date range." }, { status: 400 });
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 1096) return Response.json({ error: "Choose a range of three years or fewer." }, { status: 400 });

  try {
    const scope = await reportScope(authorization);
    const vehicle = scope.vehicles.find((item) => item.vehicle_no.toUpperCase() === vehicleNo);
    if (!vehicle) return Response.json({ error: "Vehicle not found in your Fleet access." }, { status: 404 });
    const vehicleRecord = await supabaseAdmin.from("fleet_vehicles").select("id,created_at").eq("company_id", scope.companyId).eq("vehicle_no", vehicleNo).maybeSingle();
    if (vehicleRecord.error || !vehicleRecord.data) throw new FleetReportError("Unable to load the vehicle lifecycle.");
    const fromTime = `${from}T00:00:00.000Z`; const toTime = `${to}T23:59:59.999Z`;
    const [history, km, fuel, service, audits] = await Promise.all([
      readAllRows(supabaseAdmin.from("fleet_vehicle_status_history").select("id,status_key,status_label,status_reason_key,status_reason_label,comment,expected_operational_date,started_at,ended_at").eq("company_id", scope.companyId).eq("vehicle_id", vehicleRecord.data.id).lte("started_at", toTime).or(`ended_at.is.null,ended_at.gte.${fromTime}`).order("started_at")),
      readAllRows(supabaseAdmin.from("fleet_daily_km").select("movement_date,km,source,confidence_percent,review_status,max_speed,moving_minutes,late_night,first_moving_at,last_moving_at").eq("company_id", scope.companyId).eq("vehicle_no", vehicleNo).gte("movement_date", from).lte("movement_date", to).order("movement_date")),
      readAllRows(supabaseAdmin.from("fleet_fuel_transactions").select("transaction_date,fuel_quantity,fuel_amount,provider,product,station_name").eq("company_id", scope.companyId).eq("vehicle_no", vehicleNo).gte("transaction_date", from).lte("transaction_date", to).order("transaction_date")),
      readAllRows(supabaseAdmin.from("fleet_service_history").select("id,service_date,service_type,vendor_name,amount,status,description,invoice_url,downtime_hours").eq("company_id", scope.companyId).eq("vehicle_id", vehicleRecord.data.id).gte("service_date", from).lte("service_date", to).order("service_date")),
      readAllRows(supabaseAdmin.from("fleet_audits").select("id,scheduled_for,status,score,summary,completed_at,scheduled_reason").eq("company_id", scope.companyId).eq("vehicle_id", vehicleRecord.data.id).gte("scheduled_for", from).lte("scheduled_for", to).order("scheduled_for"))
    ]);
    const error = [history, km, fuel, service, audits].find((result) => result.error)?.error;
    if (error) throw new FleetReportError("Unable to load the complete vehicle lifecycle.");
    return Response.json({ vehicle, createdAt: vehicleRecord.data.created_at, from, to, statusPeriods: history.data ?? [], dailyKm: km.data ?? [], fuel: fuel.data ?? [], services: service.data ?? [], audits: audits.data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof FleetReportError ? error.message : "Unable to load the vehicle lifecycle." }, { status: error instanceof FleetReportError ? error.status : 500 });
  }
}

import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
async function access(edit = false) {
  const auth = await getAuthorization();
  if (!auth) return { error: reply({ error: "Login required." }, 401) };
  if (edit && auth.readOnly) return { error: reply({ error: "Exit user preview before changing vehicle rent." }, 403) };
  const action = edit ? "edit" : "access";
  if (!["fleet_masters", "fleet_settings", "app_settings"].some(code => hasPermission(auth, code, action)) && !hasPermission(auth, "users", "edit"))
    return { error: reply({ error: "Vehicle Master permission required." }, 403) };
  if (!supabaseAdmin) return { error: reply({ error: "Database unavailable." }, 503) };
  const companyId = requireCompanyId(auth);
  const all = auth.isMasterOwner || auth.hasAllLocationAccess;
  const locations = await loadCodLocations(companyId, auth.locationScopeIds, all);
  if (locations.error) return { error: reply({ error: "Unable to verify location access." }, 503) };
  let query = supabaseAdmin.from("fleet_vehicles").select("id").eq("company_id", companyId);
  if (!all) query = query.in("station_code", locations.locations.map(l => l.station_code));
  const vehicles = await query;
  if (vehicles.error) return { error: reply({ error: "Unable to load permitted vehicles." }, 503) };
  return { companyId, auth, vehicleIds: (vehicles.data ?? []).map(v => v.id as string) };
}
export async function GET() {
  const context = await access();
  if ("error" in context) return context.error;
  if (!context.vehicleIds.length) return reply({ rates: [] });
  const result = await supabaseAdmin!.from("fleet_vehicle_rent_rates")
    .select("id,vehicle_id,monthly_rent,effective_from,effective_to,reason,updated_at")
    .eq("company_id", context.companyId).in("vehicle_id", context.vehicleIds)
    .order("effective_from", { ascending: false }).limit(1000);
  if (result.error || (result.data?.length ?? 0) >= 1000) return reply({ error: "Unable to load the complete rent history. Please retry or contact support." }, 503);
  return reply({ rates: result.data ?? [] });
}
export async function POST(request: Request) {
  const context = await access(true);
  if ("error" in context) return context.error;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return reply({ error: "Invalid request." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Invalid request." }, 400);
  const vehicleId = String(body.vehicleId ?? "");
  if (!context.vehicleIds.includes(vehicleId)) return reply({ error: "Vehicle is outside your permitted locations." }, 403);
  const amount = Number(body.monthlyRent), from = String(body.effectiveFrom ?? ""), reason = String(body.reason ?? "").trim();
  if (body.monthlyRent == null || body.monthlyRent === "" || !Number.isFinite(amount) || amount < 0 || amount > 9999999 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from)) || new Date(from).toISOString().slice(0,10) !== from || reason.length < 3 || reason.length > 500)
    return reply({ error: "Enter a monthly rent (up to two decimals), valid effective date and a reason of 3–500 characters." }, 400);
  const saved = await supabaseAdmin!.rpc("fleet_save_vehicle_rent", {
    p_company: context.companyId, p_vehicle: vehicleId, p_amount: amount,
    p_from: from, p_reason: reason, p_actor: context.auth.userId,
  });
  if (saved.error) { console.error("Vehicle rent save", saved.error.code); return reply({ error: "Vehicle rent could not be saved. Please retry." }, 500); }
  return reply({ ok: true, id: saved.data });
}

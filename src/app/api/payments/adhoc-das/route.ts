import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "payment_requests", "add")) return Response.json({ error: "Payment request access denied." }, { status: 403 });
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const location = params.get("location") || "";
  if (!/^[a-f0-9-]{36}$/i.test(location)) return Response.json({ error: "Choose a station." }, { status: 400 });
  const company = requireCompanyId(auth);
  const station = await supabaseAdmin.from("stations").select("station_code,station_email,station_manager_email").eq("company_id", company).eq("id", location).maybeSingle();
  if (station.error) return Response.json({ error: "Station lookup failed." }, { status: 503 });
  const email = auth.email?.trim().toLowerCase();
  if (!station.data || (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(location) && !(email && [station.data.station_email, station.data.station_manager_email].some(value => value?.trim().toLowerCase() === email)))) return Response.json({ error: "Station outside your scope." }, { status: 403 });
  const latest = await supabaseAdmin.from("cps_shipment_daily").select("work_date")
    .eq("company_id", company).eq("station_code", station.data.station_code).ilike("client", "amazon")
    .order("work_date", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) return Response.json({ error: "Unable to identify the latest Amazon shipment roster." }, { status: 503 });
  const sourceDate = latest.data?.work_date ?? null;
  const options = new Map<string, { value: string; label: string }>();
  for (let offset = 0; offset < 10000; offset += 1000) {
    const result = sourceDate ? await supabaseAdmin.from("cps_shipment_daily").select("id,client,provider_employee_id,provider_employee_name,total_delivery")
      .eq("company_id", company).eq("station_code", station.data.station_code).eq("work_date", sourceDate).ilike("client", "amazon").order("id").range(offset, offset + 999)
      : { data: [], error: null };
    if (result.error) return Response.json({ error: "Unable to load shipment data. Please retry." }, { status: 503 });
    for (const row of result.data ?? []) {
      if (!row.provider_employee_id) continue;
      const key = row.provider_employee_id.trim().toUpperCase();
      if (!options.has(key)) options.set(key, { value: row.id, label: `${row.provider_employee_name || "Unnamed DA"} — ${row.provider_employee_id}` });
    }
    if ((result.data?.length ?? 0) < 1000) {
      const workforce = await supabaseAdmin.from("workforce").select("id,dropx_id,full_name")
        .eq("company_id", company).eq("location_id", location).eq("is_active", true).is("deleted_at", null).order("full_name").limit(2000);
      if (workforce.error) return Response.json({ error: "Unable to load station payroll associates." }, { status: 503 });
      return Response.json({
        options: [...options.values()].sort((a, b) => a.label.localeCompare(b.label)),
        workforceOptions: (workforce.data ?? []).map(row => ({ value: row.id, label: row.full_name, helper: row.dropx_id || "No DropX ID" }))
      }, { headers: { "Cache-Control": "no-store" } });
    }
  }
  return Response.json({ error: "Too many records for one station/day. Contact support." }, { status: 422 });
}

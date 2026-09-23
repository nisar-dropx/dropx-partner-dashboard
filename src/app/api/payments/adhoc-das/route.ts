import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "payment_requests", "add")) return Response.json({ error: "Payment request access denied." }, { status: 403 });
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const location = params.get("location") || "", date = params.get("date") || "";
  if (!/^[a-f0-9-]{36}$/i.test(location) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "Choose a station and work date." }, { status: 400 });
  const company = requireCompanyId(auth);
  const station = await supabaseAdmin.from("stations").select("station_code,station_email,station_manager_email").eq("company_id", company).eq("id", location).maybeSingle();
  if (station.error) return Response.json({ error: "Station lookup failed." }, { status: 503 });
  const email = auth.email?.trim().toLowerCase();
  if (!station.data || (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(location) && !(email && [station.data.station_email, station.data.station_manager_email].some(value => value?.trim().toLowerCase() === email)))) return Response.json({ error: "Station outside your scope." }, { status: 403 });
  const options = new Map<string, { value: string; label: string; helper: string }>();
  for (let offset = 0; offset < 10000; offset += 1000) {
    const result = await supabaseAdmin.from("cps_shipment_daily").select("id,client,provider_employee_id,provider_employee_name,total_delivery")
      .eq("company_id", company).eq("station_code", station.data.station_code).eq("work_date", date).order("id").range(offset, offset + 999);
    if (result.error) return Response.json({ error: "Unable to load shipment data. Please retry." }, { status: 503 });
    for (const row of result.data ?? []) {
      if (!row.provider_employee_id) continue;
      const key = JSON.stringify([row.client, row.provider_employee_id, row.provider_employee_name]);
      if (!options.has(key)) options.set(key, { value: row.id, label: `${row.provider_employee_name || "Unnamed DA"} — ${row.provider_employee_id}`, helper: `${row.client} · ${station.data.station_code}` });
    }
    if ((result.data?.length ?? 0) < 1000) {
      const latest = options.size ? null : await supabaseAdmin.from("cps_shipment_daily").select("work_date").eq("company_id", company).eq("station_code", station.data.station_code).order("work_date", { ascending: false }).limit(1).maybeSingle();
      return Response.json({ options: [...options.values()].sort((a, b) => a.label.localeCompare(b.label)), latestDate: latest?.data?.work_date || null }, { headers: { "Cache-Control": "no-store" } });
    }
  }
  return Response.json({ error: "Too many records for one station/day. Contact support." }, { status: 422 });
}

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
      const name = row.provider_employee_name?.trim();
      const providerId = row.provider_employee_id?.trim();
      if (!name && !providerId) continue;
      const key = providerId ? `ID:${providerId}` : `NAME:${name}`;
      if (!options.has(key)) options.set(key, { value: row.id, label: [name || "Unnamed DA", providerId].filter(Boolean).join(" — ") });
    }
    if ((result.data?.length ?? 0) < 1000) {
      return Response.json({
        options: [...options.values()].sort((a, b) => a.label.localeCompare(b.label))
      }, { headers: { "Cache-Control": "no-store" } });
    }
  }
  return Response.json({ error: "Too many records for one station/day. Contact support." }, { status: 422 });
}

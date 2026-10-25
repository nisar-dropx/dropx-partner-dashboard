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
  const providerResult = await supabaseAdmin.from("stations").select("providers(code,name)").eq("company_id", company).eq("id", location).single();
  if (providerResult.error) return Response.json({ error: "Unable to identify the station provider." }, { status: 503 });
  const related: any = providerResult.data?.providers;
  const provider = Array.isArray(related) ? related[0] : related;
  const providerText = `${provider?.code ?? ""} ${provider?.name ?? ""}`.toLowerCase();
  const client = providerText.includes("flipkart") ? "Flipkart" : providerText.includes("amazon") ? "Amazon" : null;
  if (!client) return Response.json({ error: "This station does not have an Amazon or Flipkart provider configured." }, { status: 422 });
  const result = await supabaseAdmin.rpc("payment_adhoc_da_roster", { p_company_id: company, p_station_id: location });
  if (result.error) return Response.json({ error: "Unable to load the imported associate roster. Please retry." }, { status: 503 });
  return Response.json({ client, options: (result.data ?? []).map((row: any) => ({ value: row.shipment_id, label: `${row.associate_name || "Unnamed associate"} — ${row.provider_member_id}` })) }, { headers: { "Cache-Control": "no-store" } });
}

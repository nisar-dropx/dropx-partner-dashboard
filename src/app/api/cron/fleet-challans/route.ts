import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/portal-digest-delivery";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily challan portal sync.
 * Remains skipped until FLEET_CHALLAN_PORTAL_SYNC_ENABLED=true AND an authorized
 * provider URL/key is configured. Manual + ingest paths remain live without this.
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: "Database unavailable." }, { status: 500 });

  const enabled = String(process.env.FLEET_CHALLAN_PORTAL_SYNC_ENABLED || "").trim().toLowerCase() === "true";
  const providerUrl = String(process.env.FLEET_CHALLAN_PROVIDER_URL || "").trim();
  const providerKey = String(process.env.FLEET_CHALLAN_PROVIDER_KEY || "").trim();

  const companies = await supabaseAdmin.from("companies").select("id,name").eq("is_active", true);
  if (companies.error) return NextResponse.json({ error: companies.error.message }, { status: 500 });

  const runs: Array<{ companyId: string; status: string; message?: string }> = [];

  for (const company of companies.data ?? []) {
    const started = await supabaseAdmin
      .from("fleet_challan_sync_runs")
      .insert({
        company_id: company.id,
        status: "running",
        metadata: { enabled, providerConfigured: Boolean(providerUrl && providerKey) }
      })
      .select("id")
      .single();
    if (started.error) {
      runs.push({ companyId: company.id, status: "failed", message: started.error.message });
      continue;
    }

    if (!enabled || !providerUrl || !providerKey) {
      await supabaseAdmin
        .from("fleet_challan_sync_runs")
        .update({
          status: "skipped",
          finished_at: new Date().toISOString(),
          error_message: "Portal sync disabled until an authorized MVD/provider integration is configured.",
          metadata: { enabled, providerConfigured: Boolean(providerUrl && providerKey), reason: "awaiting_authorized_provider" }
        })
        .eq("id", started.data.id);
      runs.push({ companyId: company.id, status: "skipped", message: "Awaiting authorized provider credentials." });
      continue;
    }

    // Provider adapter placeholder — enable only with a signed DropX contract.
    await supabaseAdmin
      .from("fleet_challan_sync_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: "Provider adapter is not implemented for the configured endpoint yet.",
        metadata: { providerUrl }
      })
      .eq("id", started.data.id);
    runs.push({ companyId: company.id, status: "failed", message: "Provider adapter pending implementation." });
  }

  return NextResponse.json({
    ok: true,
    enabled,
    runs,
    note: "Challan UI, manual entry, ingest webhook and NL recovery bridge are live. Daily portal scrape stays gated."
  });
}

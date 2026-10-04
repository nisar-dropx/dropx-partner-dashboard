import { NextResponse } from "next/server";
import { auditProgrammeFromRiskWeights } from "@/lib/fleet/audit-programme-config";
import { generateFleetAuditProgramme } from "@/lib/fleet/audit-programme";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

function currentMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });
  const month = new URL(request.url).searchParams.get("month") || currentMonth();
  const companyId = new URL(request.url).searchParams.get("companyId")?.trim();
  let settingsQuery = supabaseAdmin.from("fleet_control_settings").select("company_id,risk_weights");
  if (companyId) settingsQuery = settingsQuery.eq("company_id", companyId);
  const settings = await settingsQuery;
  if (settings.error) return NextResponse.json({ error: settings.error.message }, { status: 500 });
  const results = [];
  for (const setting of settings.data ?? []) {
    if (!auditProgrammeFromRiskWeights(setting.risk_weights).enabled) continue;
    try { results.push({ companyId: setting.company_id, ok: true, ...await generateFleetAuditProgramme(setting.company_id, month) }); }
    catch (error) { results.push({ companyId: setting.company_id, ok: false, error: error instanceof Error ? error.message : "Audit programme failed." }); }
  }
  return NextResponse.json({ ok: results.every((result) => result.ok), month, results });
}

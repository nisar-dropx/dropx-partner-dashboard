import { cronAuthorized } from "@/lib/portal-digest-delivery";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { ensureAuditProgramme } from "@/lib/ops-pulse/station-audits";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isEddCronHost(new URL(request.url).hostname)) return Response.json({ skipped: "Station audits run on OpsPulse only" });
  if (!supabaseAdmin) return Response.json({ error: "Database service role is unavailable." }, { status: 500 });
  const companies = await supabaseAdmin.from("ops_audit_types").select("company_id").eq("is_active", true);
  if (companies.error) return Response.json({ error: companies.error.message }, { status: 500 });
  const ids = [...new Set((companies.data ?? []).map((row) => row.company_id).filter(Boolean))];
  const results = await Promise.allSettled(ids.map((companyId) => ensureAuditProgramme(companyId)));
  const failed = results.some((result) => result.status === "rejected");
  return Response.json({ companies: ids.length, results: results.map((result) => result.status === "fulfilled" ? result.value : { error: String(result.reason) }) }, { status: failed ? 500 : 200 });
}

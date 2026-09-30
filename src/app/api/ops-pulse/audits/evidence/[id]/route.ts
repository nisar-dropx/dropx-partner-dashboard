import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canUseStationAuditLocation } from "@/lib/ops-pulse/station-audits";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const authorization = await getAuthorization(); if (!authorization || !hasPermission(authorization, "station_audits", "access")) return Response.json({ error: "Audit evidence access denied." }, { status: 403 });
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 500 }); const companyId = requireCompanyId(authorization);
  const evidence = await supabaseAdmin.from("ops_station_audit_evidence").select("id,file_name,media_url,ops_station_audits!inner(location_id)").eq("company_id", companyId).eq("id", params.id).maybeSingle();
  if (evidence.error) return Response.json({ error: evidence.error.message }, { status: 500 }); const row: any = evidence.data; const audit = Array.isArray(row?.ops_station_audits) ? row.ops_station_audits[0] : row?.ops_station_audits;
  if (!row || !audit || !canUseStationAuditLocation(authorization, audit.location_id)) return Response.json({ error: "Evidence is unavailable in your station scope." }, { status: 404 });
  if (!String(row.media_url).startsWith("storage://")) return Response.redirect(row.media_url);
  const match = String(row.media_url).match(/^storage:\/\/([^/]+)\/(.+)$/); if (!match) return Response.json({ error: "Evidence reference is invalid." }, { status: 400 }); const file = await supabaseAdmin.storage.from(match[1]).download(match[2]);
  if (file.error || !file.data) return Response.json({ error: file.error?.message ?? "Evidence file is unavailable." }, { status: 404 });
  return new Response(await file.data.arrayBuffer(), { headers: { "Content-Type": file.data.type || "application/octet-stream", "Content-Disposition": `inline; filename="${String(row.file_name || "audit-evidence").replace(/[^a-zA-Z0-9._-]/g, "_")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

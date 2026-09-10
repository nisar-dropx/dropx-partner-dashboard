import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { reviewReportDates } from "@/lib/ops-pulse/review-report";
import { loadReviewReport } from "@/lib/ops-pulse/review-report-data";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "ops_reports", "access") || !hasPermission(auth, "performance_review", "access")) return Response.json({ error: "Reports and Performance Review access are required." }, { status: 403, headers: noStore });
  const url = new URL(request.url), from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "", format = url.searchParams.get("format") || "json";
  try { reviewReportDates(from, to); } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400, headers: noStore }); }
  if (!["json", "xlsx", "pdf"].includes(format)) return Response.json({ error: "Choose Excel or PDF." }, { status: 400, headers: noStore });
  const requested = [...new Set((url.searchParams.get("stations") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!requested.length || requested.length > 250 || requested.some(s => !/^[A-Z0-9_ -]{1,50}$/.test(s))) return Response.json({ error: "Select at least one valid station (up to 250)." }, { status: 400, headers: noStore });
  const companyId = requireCompanyId(auth);
  const scope = await loadCodLocations(companyId, auth.locationScopeIds, auth.hasAllLocationAccess);
  if (scope.error) return Response.json({ error: "Station scope could not be verified. Please retry." }, { status: 503, headers: noStore });
  if (requested.some(code => !scope.locations.some(s => s.station_code === code))) return Response.json({ error: "One or more selected stations are outside your permitted scope." }, { status: 403, headers: noStore });
  try {
    const report = await loadReviewReport(companyId, scope.locations.filter(s => requested.includes(s.station_code)), from, to);
    if (format === "json") return Response.json({ generatedAt: report.generatedAt, rows: report.tables[0].rows, notes: report.notes, sections: report.tables.map(t => ({ name: t.name, count: t.rows.length })) }, { headers: noStore });
    const { reviewReportPdf, reviewReportXlsx } = await import("@/lib/ops-pulse/review-report-export");
    const bytes = format === "pdf" ? await reviewReportPdf(report) : await reviewReportXlsx(report);
    return new Response(new Uint8Array(bytes), { headers: { ...noStore, "Content-Type": format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="OpsPulse-Review-Summary-${from}-to-${to}.${format}"` } });
  } catch (error) {
    console.error("Review summary export failed", { message: (error as Error).message });
    const message = (error as Error).message;
    const safe = /too large|shorter|exceeds|not supported|Download Excel/i.test(message);
    return Response.json({ error: safe ? message : "The full review report could not be generated. No partial download was created. Please retry or select a shorter date range." }, { status: safe ? 422 : 503, headers: noStore });
  }
}

export const dynamic = "force-dynamic";

import { getAuthorization, hasPermission } from "@/lib/authorization";
import { reportAutoGet, isReportAutoWorkerConfigured } from "@/lib/report-auto-worker";

/** GET /api/report-imports/portal-session?portal=iocl|bpcl */
export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  if (!hasPermission(authorization, "imports", "add") && !hasPermission(authorization, "imports", "edit")) {
    return Response.json({ error: "Report import permission denied." }, { status: 403 });
  }
  if (!isReportAutoWorkerConfigured()) {
    return Response.json({ error: "Report auto worker is not configured." }, { status: 503 });
  }

  const portal = new URL(request.url).searchParams.get("portal") || "";
  try {
    const session = await reportAutoGet<Record<string, unknown>>(
      `/api/admin/portal/fuel-session?portal=${encodeURIComponent(portal)}`
    );
    return Response.json(session, { status: session.ok ? 200 : 503 });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

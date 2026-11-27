import { NextResponse } from "next/server";
import { requireDsOperationsApi } from "@/lib/ops-pulse/ds-live-performance-guard";
import {
  loadDatomsAlerts,
  loadDatomsReports,
  loadDatomsThings,
  runPortalDatomsReportsSnapshot,
  runPortalDatomsThingsSnapshot,
  triggerDatomsPoll
} from "@/lib/ops-pulse/datoms-alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const gate = await requireDsOperationsApi("ds_datoms");
  if (gate.error) return gate.error;
  const view = new URL(request.url).searchParams.get("view") || "alerts";
  try {
    if (view === "things") {
      const things = await loadDatomsThings(gate.authorization);
      return NextResponse.json({ things });
    }
    if (view === "reports") {
      const reports = await loadDatomsReports(gate.authorization);
      return NextResponse.json({ reports });
    }
    const alerts = await loadDatomsAlerts(gate.authorization);
    return NextResponse.json({
      alerts,
      poll: { mode: "cron", interval_seconds: 600 }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load Datoms data." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const gate = await requireDsOperationsApi("ds_datoms");
  if (gate.error) return gate.error;
  let action = "poll-alerts";
  try {
    const body = await request.json().catch(() => ({}));
    action = String(body?.action ?? "poll-alerts");
  } catch {
    /* empty */
  }

  try {
    if (action === "poll-things") {
      const result = await runPortalDatomsThingsSnapshot({ allowLogin: false });
      return NextResponse.json({ ok: true, result });
    }
    if (action === "poll-reports") {
      const result = await runPortalDatomsReportsSnapshot({ allowLogin: false });
      return NextResponse.json({ ok: true, result });
    }
    if (action === "poll-alerts" || action === "run") {
      const result = await triggerDatomsPoll();
      return NextResponse.json({ ok: true, result });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Datoms action failed." },
      { status: 502 }
    );
  }
}

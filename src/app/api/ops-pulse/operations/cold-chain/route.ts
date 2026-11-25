import { NextResponse } from "next/server";
import { requireDsOperationsApi } from "@/lib/ops-pulse/ds-live-performance-guard";
import { loadDatomsAlerts, triggerDatomsPoll } from "@/lib/ops-pulse/datoms-alerts";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireDsOperationsApi("ds_cold_chain_alerts");
  if (gate.error) return gate.error;
  try {
    const alerts = await loadDatomsAlerts(gate.authorization);
    return NextResponse.json({ alerts });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load alerts." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const gate = await requireDsOperationsApi("ds_cold_chain_alerts");
  if (gate.error) return gate.error;
  let action = "run";
  try {
    const body = await request.json().catch(() => ({}));
    action = String(body?.action ?? "run");
  } catch {
    /* empty */
  }
  if (action !== "run") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  try {
    const result = await triggerDatomsPoll();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Poll failed." },
      { status: 502 }
    );
  }
}

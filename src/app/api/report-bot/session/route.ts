import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { reportBotApiAuthorization } from "@/lib/report-bot/access";
import { loadReportBotSettings, reportBotDb } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError, type WorkerSession } from "@/lib/report-bot/worker-client";

export const dynamic = "force-dynamic";

/** Polled by the Connection tab while linking. Only people who can edit the bot see the QR. */
export async function GET() {
  const authorization = await reportBotApiAuthorization("edit");
  if (!authorization) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  const settings = await loadReportBotSettings(authorization.companyId!);
  try {
    const session = await workerRequest<WorkerSession>(settings, "/session", { timeoutMs: 8000 });
    const number = session.me?.id ? session.me.id.split("@")[0].split(":")[0] : null;
    await reportBotDb().from("report_bot_settings").update({
      connection_state: session.state,
      connected_number: session.state === "open" ? number : session.state === "logged_out" ? null : settings.connected_number,
      connected_name: session.state === "open" ? session.me?.name ?? null : session.state === "logged_out" ? null : settings.connected_name,
      connection_error: session.last_error,
      last_worker_seen_at: new Date().toISOString()
    }).eq("company_id", settings.company_id);
    return NextResponse.json({
      state: session.state,
      qr_image: session.state === "qr" && session.qr ? await QRCode.toDataURL(session.qr, { margin: 1, width: 280 }) : null,
      pairing_code: session.state === "pairing" ? session.pairing_code : null,
      number,
      name: session.me?.name ?? null,
      error: session.last_error
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof WorkerError ? error.message : "Worker is unreachable.";
    return NextResponse.json({ state: "unreachable", error: message }, { status: 200, headers: { "cache-control": "no-store" } });
  }
}

import { NextResponse } from "next/server";
import { canSeeGroup, reportBotApiAuthorization } from "@/lib/report-bot/access";
import { AiError } from "@/lib/report-bot/ai";
import { fetchReportImage } from "@/lib/report-bot/image";
import { loadReportBotSettings, reportBotDb } from "@/lib/report-bot/settings";
import { WorkerError } from "@/lib/report-bot/worker-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Shows a report image fetched live from WhatsApp (via the worker); the portal never stores it. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const authorization = await reportBotApiAuthorization("access");
  if (!authorization) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const submission = await reportBotDb().from("report_bot_submissions")
    .select("media_ref, wa_message_record, group:report_bot_groups(location_id)")
    .eq("company_id", authorization.companyId!)
    .eq("id", params.id)
    .maybeSingle();
  const row = submission.data as { media_ref: string | null; wa_message_record: string | null; group: { location_id: string | null } | null } | null;
  if (!row?.media_ref || !canSeeGroup(authorization, { location_id: row.group?.location_id ?? null })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const image = await fetchReportImage(await loadReportBotSettings(authorization.companyId!), row.media_ref, row.wa_message_record);
    return new NextResponse(Buffer.from(image), {
      headers: { "content-type": "image/jpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    });
  } catch (error) {
    const message = error instanceof WorkerError || error instanceof AiError ? error.message : "Image unavailable.";
    const status = error instanceof WorkerError && error.unavailable ? 503 : 404;
    return new NextResponse(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
}

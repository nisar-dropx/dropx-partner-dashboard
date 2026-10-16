import { NextResponse } from "next/server";
import { reportBotApiAuthorization } from "@/lib/report-bot/access";
import { ensureWorkerToken, loadReportBotSettings, workerEnvFile } from "@/lib/report-bot/settings";

export const dynamic = "force-dynamic";

/** Downloads the worker's .env with the token filled in. Editors only: it contains a secret. */
export async function GET() {
  const authorization = await reportBotApiAuthorization("edit");
  if (!authorization) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  const settings = await ensureWorkerToken(await loadReportBotSettings(authorization.companyId!));
  return new NextResponse(workerEnvFile(settings), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": "attachment; filename=\"report-bot-worker.env\"",
      "cache-control": "private, no-store"
    }
  });
}

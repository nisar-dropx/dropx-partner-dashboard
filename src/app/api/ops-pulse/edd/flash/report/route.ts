import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchLoadFlashNetwork } from "@/lib/ops-pulse/edd-worker";
import { loadFlashReportFilename, loadFlashReportSheets, type LoadFlashReportKind } from "@/lib/ops-pulse/load-flash-report";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const KINDS = new Set<LoadFlashReportKind>(["full", "load", "edd", "road", "delivered", "returns", "pickups"]);

export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? "";
    const requested = url.searchParams.get("report") ?? "full";
    const kind: LoadFlashReportKind = KINDS.has(requested as LoadFlashReportKind) ? (requested as LoadFlashReportKind) : "full";
    const payload = await fetchLoadFlashNetwork(date || undefined);
    return workbookResponse(loadFlashReportSheets(payload, kind), loadFlashReportFilename(payload.businessDate || date || "report", kind));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Ops Live report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

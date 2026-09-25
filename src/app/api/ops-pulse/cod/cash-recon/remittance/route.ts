import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { fetchRemittance, isCashReconWorkerConfigured } from "@/lib/ops-pulse/cash-recon-worker";
import { requireCompanyId } from "@/lib/company-scope";
import { loadTechHoldsForDate } from "@/lib/ops-pulse/cod-tech-issues";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization || !hasPermission(authorization, "cod_executive_reconciliation", "access")) {
      return NextResponse.json({ error: "Executive reconciliation access denied." }, { status: 403 });
    }
    if (!isCashReconWorkerConfigured()) {
      return NextResponse.json(
        { error: "Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY." },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({})) as {
      stationCode?: string;
      date?: string;
    };
    const stationCode = String(body.stationCode ?? "").trim().toUpperCase();
    const date = String(body.date ?? "").trim();
    if (!stationCode || !date) {
      return NextResponse.json({ error: "stationCode and date are required." }, { status: 400 });
    }

    const techHolds = await loadTechHoldsForDate(requireCompanyId(authorization), stationCode, date);
    const result = await fetchRemittance({ stationCode, date, techHolds });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load remittance summary.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

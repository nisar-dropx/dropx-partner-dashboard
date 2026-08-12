import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { isCashReconWorkerConfigured, verifyRemittance } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const authorization = await getAuthorization();
    const canSubmit = authorization && hasPermission(authorization, "cod_submission", "access");
    const canReconcile = authorization && hasPermission(authorization, "cod_executive_reconciliation", "access");
    if (!canSubmit && !canReconcile) {
      return NextResponse.json({ error: "COD submission access denied." }, { status: 403 });
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
      remittanceCode?: string;
      amount?: number | string;
      codPeriodFrom?: string;
      codPeriodTo?: string;
      submittedBy?: string;
      fresh?: boolean;
    };

    const stationCode = String(body.stationCode ?? "").trim().toUpperCase();
    const date = String(body.date ?? "").trim();
    const remittanceCode = String(body.remittanceCode ?? "").trim();
    const codPeriodFrom = String(body.codPeriodFrom ?? "").trim();
    const codPeriodTo = String(body.codPeriodTo ?? "").trim();
    const submittedBy = String(body.submittedBy ?? "").trim();
    const amount = typeof body.amount === "number"
      ? body.amount
      : Number(String(body.amount ?? "").replace(/,/g, "").trim());

    if (!stationCode || !date || !remittanceCode) {
      return NextResponse.json(
        { error: "stationCode, date, and remittanceCode are required." },
        { status: 400 }
      );
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: "amount must be a non-negative number." }, { status: 400 });
    }

    const result = await verifyRemittance({
      stationCode,
      date,
      remittanceCode,
      amount,
      codPeriodFrom: codPeriodFrom || undefined,
      codPeriodTo: codPeriodTo || undefined,
      submittedBy: submittedBy || undefined,
      fresh: body.fresh === true
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to verify remittance.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

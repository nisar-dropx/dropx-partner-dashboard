import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { isCashReconWorkerConfigured } from "@/lib/ops-pulse/cash-recon-worker";

export function hasCiaAccess(authorization: AuthorizationContext | null) {
  if (!authorization) return false;
  return hasPermission(authorization, "cod_executive_reconciliation", "access")
    || hasPermission(authorization, "cod_reports", "access")
    || hasPermission(authorization, "cod_cash_in_associate", "access");
}

export async function requireCiaAccess() {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!hasCiaAccess(authorization)) {
    redirect("/unauthorized?page=cod_cash_in_associate&action=access");
  }
  return authorization;
}

/** Shared CIA API gate: permission + worker config. Returns a response when the request should stop. */
export async function requireCiaApi() {
  const authorization = await getAuthorization();
  if (!hasCiaAccess(authorization)) {
    return NextResponse.json({ error: "Cash In Associate access denied." }, { status: 403 });
  }
  if (!isCashReconWorkerConfigured()) {
    return NextResponse.json(
      { error: "Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY." },
      { status: 503 }
    );
  }
  return null;
}

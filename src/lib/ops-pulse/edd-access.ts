import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";

export function hasEddAccess(authorization: AuthorizationContext | null) {
  if (!authorization) return false;
  return hasPermission(authorization, "edd_dashboard", "access")
    || hasPermission(authorization, "cod_cash_in_associate", "access")
    || hasPermission(authorization, "cod_reports", "access");
}

export async function requireEddAccess() {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!hasEddAccess(authorization)) {
    redirect("/unauthorized?page=edd_dashboard&action=access");
  }
  return authorization;
}

/** Shared EDD API gate: permission + worker config. Returns a response when the request should stop. */
export async function requireEddApi() {
  const authorization = await getAuthorization();
  if (!hasEddAccess(authorization)) {
    return NextResponse.json({ error: "Delivery Performance access denied." }, { status: 403 });
  }
  if (!isEddWorkerConfigured()) {
    return NextResponse.json(
      { error: "EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_SECRET." },
      { status: 503 }
    );
  }
  return null;
}

import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { canViewEddAgeingPerformance } from "@/lib/ops-pulse/edd-ageing-performance-access";
import { isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";

export { canViewEddAgeingPerformance } from "@/lib/ops-pulse/edd-ageing-performance-access";

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

/** Pages for Ageing / Performance — other Live performance tabs stay on requireEddAccess. */
export async function requireEddAgeingPerformanceAccess() {
  const authorization = await requireEddAccess();
  if (!canViewEddAgeingPerformance(authorization)) {
    redirect("/edd/flash");
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

/** API gate for Ageing / Performance endpoints only. */
export async function requireEddAgeingPerformanceApi() {
  const denied = await requireEddApi();
  if (denied) return denied;
  const authorization = await getAuthorization();
  if (!canViewEddAgeingPerformance(authorization)) {
    return NextResponse.json(
      { error: "Ageing and Performance access is limited to FSD, Managing Partner, and Finance Head." },
      { status: 403 }
    );
  }
  return null;
}

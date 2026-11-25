import "server-only";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getAuthorization, type AuthorizationContext } from "@/lib/authorization";
import {
  canViewDsOperations,
  type DsOperationsPageCode
} from "@/lib/ops-pulse/ds-live-performance-access";

export async function requireDsOperationsAccess(
  pageCode: DsOperationsPageCode = "ds_live_performance"
): Promise<AuthorizationContext> {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!canViewDsOperations(authorization, pageCode)) {
    redirect(`/unauthorized?page=${encodeURIComponent(pageCode)}`);
  }
  return authorization;
}

/** @deprecated Prefer requireDsOperationsAccess */
export async function requireDsLivePerformanceAccess(): Promise<AuthorizationContext> {
  return requireDsOperationsAccess("ds_live_performance");
}

/** API gate — returns a response when the request should stop (no redirect). */
export async function requireDsOperationsApi(
  pageCode: DsOperationsPageCode | "any" = "ds_live_performance"
): Promise<
  { authorization: AuthorizationContext; error: null } | { authorization: null; error: NextResponse }
> {
  const authorization = await getAuthorization();
  if (!authorization) {
    return { authorization: null, error: NextResponse.json({ error: "Login required." }, { status: 401 }) };
  }
  const allowed =
    pageCode === "any"
      ? (["ds_live_performance", "ds_ppi", "ds_site_summary", "ds_cold_chain_alerts"] as const).some((code) =>
          canViewDsOperations(authorization, code)
        )
      : canViewDsOperations(authorization, pageCode);
  if (!allowed) {
    return {
      authorization: null,
      error: NextResponse.json({ error: "Dark Store Operations is limited to FSD and Admin." }, { status: 403 })
    };
  }
  return { authorization, error: null };
}

/** Shared API used by Live, PPI and Site Summary — any Operations page grant is enough. */
export async function requireDsLivePerformanceApi() {
  return requireDsOperationsApi("any");
}

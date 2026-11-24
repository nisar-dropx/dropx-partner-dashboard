import "server-only";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getAuthorization, type AuthorizationContext } from "@/lib/authorization";
import { canViewDsLivePerformance } from "@/lib/ops-pulse/ds-live-performance-access";

export async function requireDsLivePerformanceAccess(): Promise<AuthorizationContext> {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!canViewDsLivePerformance(authorization)) {
    redirect("/unauthorized?page=ds_live_performance");
  }
  return authorization;
}

/** API gate — returns a response when the request should stop (no redirect). */
export async function requireDsLivePerformanceApi(): Promise<
  { authorization: AuthorizationContext; error: null } | { authorization: null; error: NextResponse }
> {
  const authorization = await getAuthorization();
  if (!authorization) {
    return { authorization: null, error: NextResponse.json({ error: "Login required." }, { status: 401 }) };
  }
  if (!canViewDsLivePerformance(authorization)) {
    return {
      authorization: null,
      error: NextResponse.json({ error: "Dark Store Live performance is limited to FSD and Admin." }, { status: 403 })
    };
  }
  return { authorization, error: null };
}

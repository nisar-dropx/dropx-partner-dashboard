import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";

export type StationEddApiContext = {
  authorization: AuthorizationContext;
  companyId: string;
};

export function hasStationEddAccess(authorization: AuthorizationContext | null) {
  return Boolean(authorization && hasPermission(authorization, "edd_dashboard", "access"));
}

export async function requireStationEddAccess() {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!hasStationEddAccess(authorization)) {
    redirect("/unauthorized?page=edd_dashboard&action=access");
  }
  return authorization;
}

/** Shared gate for the new EDD APIs. The worker key remains server-only. */
export async function stationEddApiContext(): Promise<StationEddApiContext | NextResponse> {
  const authorization = await getAuthorization();
  if (!hasStationEddAccess(authorization)) {
    return NextResponse.json({ error: "EDD access denied." }, { status: 403 });
  }
  if (!isEddWorkerConfigured()) {
    return NextResponse.json({ error: "EDD worker is not configured." }, { status: 503 });
  }
  return { authorization: authorization!, companyId: requireCompanyId(authorization!) };
}

export function isStationEddApiDenied(
  value: StationEddApiContext | NextResponse
): value is NextResponse {
  return value instanceof NextResponse;
}

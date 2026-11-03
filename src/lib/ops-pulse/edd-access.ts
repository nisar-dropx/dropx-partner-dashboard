import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { canViewEddAgeingPerformance } from "@/lib/ops-pulse/edd-ageing-performance-access";
import { isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";

export { canViewEddAgeingPerformance } from "@/lib/ops-pulse/edd-ageing-performance-access";

export const eddSectionPermissions = {
  flash: "edd_live_ops",
  board: "edd_station_board",
  ageing: "edd_ageing",
  performance: "edd_performance",
  edds: "edd_edds",
  scorecard: "edd_scorecard",
  scrub: "edd_scrub",
} as const;

export type EddSectionKey = keyof typeof eddSectionPermissions;
export type EddPermissionCode = (typeof eddSectionPermissions)[EddSectionKey];

export function allowedEddSections(authorization: AuthorizationContext | null): EddSectionKey[] {
  if (!authorization) return [];
  return (Object.entries(eddSectionPermissions) as Array<[EddSectionKey, EddPermissionCode]>)
    .filter(([, code]) => hasPermission(authorization, code, "access"))
    .map(([key]) => key);
}

export function hasEddAccess(authorization: AuthorizationContext | null, pageCode?: EddPermissionCode) {
  if (!authorization) return false;
  if (pageCode) return hasPermission(authorization, pageCode, "access");
  return allowedEddSections(authorization).length > 0;
}

export async function requireEddAccess(pageCode: EddPermissionCode = eddSectionPermissions.flash) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!hasEddAccess(authorization, pageCode)) {
    redirect(`/unauthorized?page=${pageCode}&action=access`);
  }
  return authorization;
}

/** Pages for Ageing / Performance — other Live performance tabs stay on requireEddAccess. */
export async function requireEddAgeingPerformanceAccess(pageCode: Extract<EddPermissionCode, "edd_ageing" | "edd_performance">) {
  const authorization = await requireEddAccess(pageCode);
  if (!canViewEddAgeingPerformance(authorization)) {
    redirect("/edd/flash");
  }
  return authorization;
}

/** Shared EDD API gate: permission + worker config. Returns a response when the request should stop. */
export async function requireEddApi(pageCode: EddPermissionCode = eddSectionPermissions.flash) {
  const authorization = await getAuthorization();
  if (!hasEddAccess(authorization, pageCode)) {
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
export async function requireEddAgeingPerformanceApi(pageCode: Extract<EddPermissionCode, "edd_ageing" | "edd_performance">) {
  const denied = await requireEddApi(pageCode);
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

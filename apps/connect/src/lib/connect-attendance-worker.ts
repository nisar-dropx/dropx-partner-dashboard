import "server-only";

import { createHash } from "crypto";
import { cookies } from "next/headers";
import { connectSessionCookieName, normalizeConnectMobile } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isWorkforceProfileType, type WorkforceProfileType, workforceTable } from "@/lib/workforce-profiles";

export function cleanEnrolmentId(value: unknown) {
  const digits = String(value ?? "").trim().replace(/\D/g, "");
  if (!digits) return "";
  return digits.replace(/^0+/, "") || "0";
}

export type ConnectAttendanceWorker = {
  companyId: string;
  profileId: string;
  profileType: WorkforceProfileType;
  enrolmentId: string;
  fullName: string;
  locationId: string | null;
  workerType: "employee" | "individual_contract";
};

async function activeConnectSession() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Login required.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const sessionResult = await supabaseAdmin
    .from("connect_login_sessions")
    .select("id, country_code, mobile_number, expires_at, revoked_at")
    .eq("session_hash", sessionHash)
    .maybeSingle();
  if (sessionResult.error) throw new Error(sessionResult.error.message);
  const session = sessionResult.data;
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error("Login expired.");
  }
  return session;
}

export async function resolveConnectAttendanceWorker({
  accountId,
  profileType,
  requirePeopleScope = false
}: {
  accountId: string;
  profileType: string;
  requirePeopleScope?: boolean;
}): Promise<ConnectAttendanceWorker> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const session = await activeConnectSession();
  const { countryCode, mobile, localMobile } = normalizeConnectMobile(session.mobile_number, session.country_code);
  if (!isWorkforceProfileType(profileType)) {
    throw new Error("Attendance is available for workforce accounts only.");
  }
  const resolvedProfileType = profileType as WorkforceProfileType;
  if (requirePeopleScope && !["employee", "contractor"].includes(resolvedProfileType)) {
    throw new Error("Location continuity applies only to People-designated employees and individual contractors.");
  }
  const table = workforceTable(resolvedProfileType);
  const designationColumn = resolvedProfileType === "employee" ? "designation_id" : "designation";
  const result = await supabaseAdmin
    .from(table)
    .select(`id, company_id, mobile, mobile_country_code, biometric_id, full_name, location_id, ${designationColumn}`)
    .eq("id", accountId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data;
  if (!row) throw new Error("Workforce account not found.");
  const rowMobile = String(row.mobile ?? "").replace(/\D/g, "");
  const rowCountryCode = String(row.mobile_country_code ?? countryCode).replace(/\D/g, "") || countryCode;
  if (rowCountryCode !== countryCode || (rowMobile !== mobile && rowMobile !== localMobile)) {
    throw new Error("This attendance is not available for the signed-in account.");
  }
  if (requirePeopleScope) {
    const designationResult = await supabaseAdmin
      .from("designations")
      .select("id, name, code, portal_scopes, is_active")
      .eq("company_id", row.company_id)
      .eq("is_active", true);
    if (designationResult.error) throw new Error(designationResult.error.message);
    const profileDesignation = String(row[designationColumn as keyof typeof row] ?? "").trim().toLowerCase();
    const designation = (designationResult.data ?? []).find((candidate) => {
      if (resolvedProfileType === "employee") return String(candidate.id).toLowerCase() === profileDesignation;
      return [candidate.name, candidate.code].some((value) => String(value ?? "").trim().toLowerCase() === profileDesignation);
    });
    const scopes = Array.isArray(designation?.portal_scopes)
      ? designation.portal_scopes.map((scope) => String(scope).trim().toLowerCase())
      : [];
    if (!designation || !scopes.includes("people")) {
      throw new Error("Location continuity is not enabled for this workforce designation.");
    }
  }
  const biometricId = String(row.biometric_id ?? "");
  const enrolmentId = cleanEnrolmentId(biometricId) || String(row.id).replace(/-/g, "").slice(0, 16);
  return {
    companyId: row.company_id as string,
    profileId: row.id as string,
    profileType: resolvedProfileType,
    enrolmentId,
    fullName: String(row.full_name ?? ""),
    locationId: (row.location_id as string | null) ?? null,
    workerType: resolvedProfileType === "employee" ? "employee" : "individual_contract"
  };
}

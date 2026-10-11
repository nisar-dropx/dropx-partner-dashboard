import { supabaseAdmin } from "@/lib/supabase-admin";
import type { WorkforceProfileType } from "@/lib/workforce-profiles";
import { backfillHistoricalPunches, istDate } from "@/lib/biometric/attendance";
import {
  normalizeBiometricEnrolmentId
} from "@/lib/biometric/enrolment-resolution";

type WorkerType = "employee" | "individual_contract";

type EnrolmentRow = {
  account_id: string | null;
  enrolment_id: string;
  id: string;
  employee_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  field_executive_id: string | null;
  location_id: string | null;
  profile_type: string | null;
  status: string;
  worker_type: string | null;
};

function cleanEnrolmentId(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeBiometricEnrolmentId(raw);
  if (!normalized) throw new Error("Biometric enrolment ID must contain 1 to 20 digits only.");
  return normalized;
}

function boundedHistoricalBackfillStart(effectiveFrom: string, today: string) {
  const cutoff = new Date(`${today}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 61);
  const recentStart = cutoff.toISOString().slice(0, 10);
  return effectiveFrom > recentStart ? effectiveFrom : recentStart;
}

export async function syncBiometricEnrolment({
  backfillHistorical = false,
  companyId,
  createdBy,
  effectiveFrom,
  employeeId,
  enrolmentId,
  fieldExecutiveId,
  locationId,
  profileType,
  accountId,
  workerType
}: {
  backfillHistorical?: boolean;
  companyId: string;
  createdBy: string;
  effectiveFrom: string;
  employeeId?: string | null;
  enrolmentId?: string | null;
  fieldExecutiveId?: string | null;
  isActive: boolean;
  locationId: string;
  profileType?: WorkforceProfileType;
  accountId?: string | null;
  workerType: WorkerType;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const cleaned = cleanEnrolmentId(enrolmentId);
  if (workerType === "individual_contract" && !profileType) {
    throw new Error("Profile type is required for a non-employee biometric enrolment.");
  }
  const resolvedProfileType: WorkforceProfileType = profileType ?? "employee";
  const personId = accountId ?? (resolvedProfileType === "employee" ? employeeId : fieldExecutiveId);
  if (!personId) throw new Error("Worker is required for biometric enrolment.");
  const today = istDate(new Date());

  // The database reads and locks the master profile, derives every ownership
  // field and effective date, and replaces the old window atomically. Callers
  // cannot choose arbitrary enrolment rows to close or forge another owner.
  const replacement = await supabaseAdmin.rpc("replace_biometric_enrolment_assignment", {
    p_account_id: personId,
    p_actor_id: createdBy,
    p_company_id: companyId,
    p_fallback_location_id: locationId,
    p_profile_type: resolvedProfileType
  });
  if (replacement.error) throw new Error(replacement.error.message);

  const replacementRows = Array.isArray(replacement.data)
    ? replacement.data
    : replacement.data ? [replacement.data] : [];
  const assigned = replacementRows[0] as EnrolmentRow | undefined;
  if (!assigned) return;

  if (!backfillHistorical) return;

  await backfillHistoricalPunches({
    accountId: personId,
    companyId,
    // Explicit repair callers may request a bounded replay. Ordinary profile
    // saves only maintain the mapping so bulk uploads stay fast; the scheduled
    // reconciliation owns this 62-day operational window.
    effectiveFrom: boundedHistoricalBackfillStart(assigned.effective_from ?? effectiveFrom, today),
    effectiveTo: null,
    employeeId: resolvedProfileType === "employee" ? personId : null,
    enrolmentId: assigned.enrolment_id ?? cleaned ?? "",
    fieldExecutiveId: resolvedProfileType === "field_executive" ? personId : null,
    isActive: assigned.status === "Active",
    locationId: assigned.location_id ?? locationId,
    profileType: resolvedProfileType,
    workerStatus: assigned.status,
    workerType
  });
}

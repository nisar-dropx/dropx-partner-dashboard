import { supabaseAdmin } from "@/lib/supabase-admin";
import type { WorkforceProfileType } from "@/lib/workforce-profiles";
import { backfillHistoricalPunches } from "@/lib/biometric/attendance";

type WorkerType = "employee" | "individual_contract";

type EnrolmentRow = {
  account_id: string | null;
  id: string;
  employee_id: string | null;
  field_executive_id: string | null;
  profile_type: string | null;
};

function cleanEnrolmentId(value: string | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "").trim();
  const text = digits.replace(/^0+/, "") || (digits ? "0" : "");
  if (!text) return null;
  if (!/^\d{1,20}$/.test(text)) throw new Error("Biometric enrolment ID must be numeric.");
  return text;
}

export async function syncBiometricEnrolment({
  companyId,
  createdBy,
  effectiveFrom,
  employeeId,
  enrolmentId,
  fieldExecutiveId,
  isActive,
  locationId,
  profileType,
  accountId,
  workerType
}: {
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
  const personColumn = resolvedProfileType === "employee"
    ? "employee_id"
    : resolvedProfileType === "field_executive"
      ? "field_executive_id"
      : "account_id";
  const personId = accountId ?? (resolvedProfileType === "employee" ? employeeId : fieldExecutiveId);
  if (!personId) throw new Error("Worker is required for biometric enrolment.");

  const now = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);

  let existing: EnrolmentRow | null = null;
  if (cleaned) {
    // Validate the requested ID before closing the worker's current enrolment.
    // Otherwise a rejected reassignment could leave the worker unenrolled.
    const existingResult = await supabaseAdmin
      .from("biometric_enrolments")
      .select("id, employee_id, field_executive_id, profile_type, account_id")
      .eq("company_id", companyId)
      .eq("enrolment_id", cleaned)
      .is("effective_to", null);
    if (existingResult.error) throw new Error(existingResult.error.message);

    const existingRows = (existingResult.data ?? []) as EnrolmentRow[];
    existing = existingRows.find((row) => row.profile_type === resolvedProfileType && (
      personColumn === "employee_id"
        ? row.employee_id === personId
        : personColumn === "field_executive_id"
          ? row.field_executive_id === personId
          : row.account_id === personId
    )) ?? null;

    // An unchanged grandfathered enrolment remains editable. A new assignment
    // cannot claim an ID that already has any other active owner.
    if (!existing && existingRows.length > 0) {
      throw new Error(`Biometric enrolment ID ${cleaned} is already assigned to another worker.`);
    }
  }

  const deactivation = await supabaseAdmin
    .from("biometric_enrolments")
    .update({
      status: "Inactive",
      effective_to: today,
      updated_at: now
    })
    .eq("company_id", companyId)
    .eq(personColumn, personId)
    .eq("profile_type", resolvedProfileType)
    .is("effective_to", null)
    .neq("enrolment_id", cleaned ?? "");
  if (deactivation.error) throw new Error(deactivation.error.message);

  if (!cleaned) return;

  const payload = {
    company_id: companyId,
    enrolment_id: cleaned,
    worker_type: workerType,
    profile_type: resolvedProfileType,
    account_id: personId,
    employee_id: resolvedProfileType === "employee" ? personId : null,
    field_executive_id: resolvedProfileType === "field_executive" ? personId : null,
    location_id: locationId,
    status: isActive ? "Active" : "Inactive",
    effective_from: effectiveFrom,
    effective_to: isActive ? null : today,
    created_by: createdBy,
    updated_at: now
  };

  if (existing) {
    const { error } = await supabaseAdmin
      .from("biometric_enrolments")
      .update(payload)
      .eq("id", existing.id)
      .eq("company_id", companyId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabaseAdmin
      .from("biometric_enrolments")
      .insert(payload);
    if (error) throw new Error(error.message);
  }

  await backfillHistoricalPunches({
    accountId: personId,
    companyId,
    employeeId: resolvedProfileType === "employee" ? personId : null,
    enrolmentId: cleaned,
    fieldExecutiveId: resolvedProfileType === "field_executive" ? personId : null,
    isActive,
    locationId,
    profileType: resolvedProfileType,
    workerStatus: isActive ? "Active" : "Inactive",
    workerType
  });
}

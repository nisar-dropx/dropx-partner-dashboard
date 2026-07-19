import { supabaseAdmin } from "@/lib/supabase-admin";

type WorkerType = "employee" | "individual_contract";

type EnrolmentRow = {
  id: string;
  employee_id: string | null;
  field_executive_id: string | null;
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
  workerType: WorkerType;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const cleaned = cleanEnrolmentId(enrolmentId);
  const personColumn = workerType === "employee" ? "employee_id" : "field_executive_id";
  const personId = workerType === "employee" ? employeeId : fieldExecutiveId;
  if (!personId) throw new Error("Worker is required for biometric enrolment.");

  const now = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);

  await supabaseAdmin
    .from("biometric_enrolments")
    .update({
      status: "Inactive",
      effective_to: today,
      updated_at: now
    })
    .eq("company_id", companyId)
    .eq(personColumn, personId)
    .is("effective_to", null)
    .neq("enrolment_id", cleaned ?? "");

  if (!cleaned) return;

  const existingResult = await supabaseAdmin
    .from("biometric_enrolments")
    .select("id, employee_id, field_executive_id")
    .eq("company_id", companyId)
    .eq("worker_type", workerType)
    .eq("enrolment_id", cleaned)
    .is("effective_to", null)
    .maybeSingle();
  if (existingResult.error) throw new Error(existingResult.error.message);

  const existing = existingResult.data as EnrolmentRow | null;
  const belongsToSameWorker = workerType === "employee"
    ? existing?.employee_id === personId
    : existing?.field_executive_id === personId;
  if (existing && !belongsToSameWorker) {
    throw new Error("Biometric enrolment ID is already assigned to another worker.");
  }

  const payload = {
    company_id: companyId,
    enrolment_id: cleaned,
    worker_type: workerType,
    employee_id: workerType === "employee" ? personId : null,
    field_executive_id: workerType === "individual_contract" ? personId : null,
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
    return;
  }

  const { error } = await supabaseAdmin
    .from("biometric_enrolments")
    .insert(payload);
  if (error) throw new Error(error.message);
}

"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import {
  alphaNumericFromForm,
  alphaNumericRequired,
  dateFromForm,
  depositSlipAttachmentFields,
  inferFormTypeFromLocation,
  numberFromForm,
  required,
  clientForFormType,
  type CodAttachment,
  type CodFormType,
  type CodLocationRow
} from "@/lib/ops-pulse/cod";
import {
  isCashReconWorkerConfigured,
  verifyRemittance
} from "@/lib/ops-pulse/cash-recon-worker";
import { uploadOpsProof } from "@/lib/ops-pulse/upload";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type CodSubmissionActionState = {
  ok: boolean;
  error?: string;
  notice?: string;
  submissionId?: string;
};

/** Production NOT NULL columns without reliable defaults (OpenAPI required). */
const COD_SUBMISSION_SOURCE = "cod_submission";
const EMPTY_JSON = {} as Record<string, unknown>;

function isMissingFormPayloadColumn(error: { message?: string } | null | undefined) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("form_payload")
    && (message.includes("does not exist") || message.includes("schema cache"));
}

function withoutFormPayload<T extends { form_payload?: unknown }>(row: T) {
  const { form_payload: _ignored, ...rest } = row;
  void _ignored;
  return rest;
}

function readCodSubmissionFields(formData: FormData) {
  return {
    clientHint: String(formData.get("client") ?? "").trim().toLowerCase(),
    locationId: required(formData.get("location_id"), "Station"),
    remittanceCode: alphaNumericRequired(formData.get("remittance_code"), "Remittance code").toUpperCase(),
    submitterName: alphaNumericFromForm(formData.get("submitter_name"), "Submitted by", { required: false }),
    amount: numberFromForm(formData.get("deposited_amount"), "Deposited amount"),
    depositDate: dateFromForm(formData.get("deposit_date"), "Deposit date"),
    codPeriodFrom: dateFromForm(formData.get("cod_period_from"), "COD from date"),
    codPeriodTo: dateFromForm(formData.get("cod_period_to") || formData.get("cod_period_from"), "COD to date"),
    remarks: String(formData.get("remarks") ?? "").trim() || null
  };
}

async function amazonValidationOrPending(params: {
  formType: string;
  stationCode: string | null | undefined;
  depositDate: string;
  codPeriodFrom: string;
  codPeriodTo: string;
  remittanceCode: string;
  amount: number;
  submittedBy: string | null;
}) {
  if (params.formType !== "amazon") {
    return {
      validationStatus: "Pending",
      validationPayload: null as Record<string, unknown> | null,
      validatedAmount: null as number | null,
      validatedAt: null as string | null,
      remittanceCreationDate: null as string | null,
      remittanceSubmissionDate: null as string | null
    };
  }
  const stationCode = String(params.stationCode ?? "").trim().toUpperCase();
  if (!stationCode) throw new Error("Selected station is missing a station code.");
  const verified = await verifyAmazonRemittance({
    stationCode,
    depositDate: params.depositDate,
    codPeriodFrom: params.codPeriodFrom,
    codPeriodTo: params.codPeriodTo,
    remittanceCode: params.remittanceCode,
    amount: params.amount,
    submittedBy: params.submittedBy
  });
  return {
    validationStatus: "Matched",
    validationPayload: verified.validationPayload,
    validatedAmount: params.amount,
    validatedAt: new Date().toISOString(),
    remittanceCreationDate: verified.remittanceCreationDate,
    remittanceSubmissionDate: verified.remittanceSubmissionDate
  };
}

function buildFormPayload(fields: {
  formType: string;
  stationCode: string | null | undefined;
  locationId: string;
  remittanceCode: string;
  submitterName: string | null;
  amount: number;
  depositDate: string;
  codPeriodFrom: string;
  codPeriodTo: string;
  remarks: string | null;
}) {
  return {
    form_type: fields.formType || null,
    station_code: fields.stationCode ?? null,
    location_id: fields.locationId,
    remittance_code: fields.remittanceCode,
    submitter_name: fields.submitterName,
    deposited_amount: fields.amount,
    deposit_date: fields.depositDate,
    cod_period_from: fields.codPeriodFrom,
    cod_period_to: fields.codPeriodTo,
    remarks: fields.remarks
  };
}

function resolveFormType(station: CodLocationRow, clientHint: string): CodFormType | "" {
  const inferred = inferFormTypeFromLocation(station);
  if (inferred) return inferred;
  if (clientHint === "amazon" || clientHint === "flipkart") return clientHint;
  return "";
}

async function stationDetails(companyId: string, locationId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const { data, error } = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, state, providers (code, name), location_models (code, name)")
    .eq("company_id", companyId)
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Selected station is not available.");
  return data as CodLocationRow;
}

async function verifyAmazonRemittance(params: {
  stationCode: string;
  depositDate: string;
  codPeriodFrom: string;
  codPeriodTo: string;
  remittanceCode: string;
  amount: number;
  submittedBy: string | null;
}) {
  if (!isCashReconWorkerConfigured()) {
    throw new Error(
      "Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY."
    );
  }
  const verify = await verifyRemittance({
    stationCode: params.stationCode,
    date: params.depositDate,
    remittanceCode: params.remittanceCode,
    amount: params.amount,
    codPeriodFrom: params.codPeriodFrom,
    codPeriodTo: params.codPeriodTo,
    submittedBy: params.submittedBy,
    fresh: true
  });
  const match = verify.matches[0] ?? null;
  const validationPayload = {
    remittance_verify: {
      verified: verify.verified,
      codeFound: verify.codeFound,
      amountMatched: verify.amountMatched,
      depositDateMatched: verify.depositDateMatched,
      creationPeriodMatched: verify.creationPeriodMatched,
      submitterMatched: verify.submitterMatched,
      failureReason: verify.failureReason,
      remittanceCode: verify.remittanceCode,
      amount: verify.amount,
      matches: verify.matches,
      nearMisses: verify.nearMisses,
      checkedAt: new Date().toISOString(),
      source: "executive/remittance/verify"
    }
  };
  if (!verify.verified) {
    throw new Error(
      verify.failureReason ||
        (!verify.codeFound
          ? `Remittance code ${params.remittanceCode} was not found on Amazon portal.`
          : `Remittance code found but details do not match for deposit ${params.depositDate}.`)
    );
  }
  return {
    validationPayload,
    remittanceCreationDate: match?.creationDateIst ?? null,
    remittanceSubmissionDate: match?.submissionDateIst ?? null
  };
}

async function uploadSlipPhotos(companyId: string, submissionId: string, formData: FormData) {
  return (
    await Promise.all(
      depositSlipAttachmentFields.map(([field, label]) =>
        uploadOpsProof({
          companyId,
          field,
          file: formData.get(field),
          label,
          section: "cod-submissions",
          submissionId,
          imagesOnly: true
        })
      )
    )
  ).filter(Boolean) as CodAttachment[];
}

function revalidateCodPaths() {
  revalidatePath("/ops-pulse/cod/submission");
  revalidatePath("/cod/submission");
  revalidatePath("/ops-pulse/cod/reports");
  revalidatePath("/cod/reports");
}

export async function createCodSubmission(
  _prev: CodSubmissionActionState | null,
  formData: FormData
): Promise<CodSubmissionActionState> {
  try {
    const authorization = await requirePagePermission("cod_submission", "add");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

    const fields = readCodSubmissionFields(formData);
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(fields.locationId)) {
      throw new Error("You do not have access to the selected station.");
    }

    const station = await stationDetails(companyId, fields.locationId);
    const formType = resolveFormType(station, fields.clientHint);
    const amazon = await amazonValidationOrPending({
      formType,
      stationCode: station.station_code,
      depositDate: fields.depositDate,
      codPeriodFrom: fields.codPeriodFrom,
      codPeriodTo: fields.codPeriodTo,
      remittanceCode: fields.remittanceCode,
      amount: fields.amount,
      submittedBy: fields.submitterName
    });

    const submissionId = randomUUID();
    const depositAttachments = await uploadSlipPhotos(companyId, submissionId, formData);

    if (!depositAttachments.length) {
      throw new Error("Upload a photo of the deposit slip (JPG or PNG).");
    }

    const nowIso = new Date().toISOString();
    const formPayload = buildFormPayload({
      formType,
      stationCode: station.station_code,
      locationId: fields.locationId,
      remittanceCode: fields.remittanceCode,
      submitterName: fields.submitterName,
      amount: fields.amount,
      depositDate: fields.depositDate,
      codPeriodFrom: fields.codPeriodFrom,
      codPeriodTo: fields.codPeriodTo,
      remarks: fields.remarks
    });
    const insertRow = withCompany(
      {
        id: submissionId,
        ai_result: EMPTY_JSON,
        ai_status: "Not queued",
        ai_summary: null,
        attachments: depositAttachments,
        client: formType ? clientForFormType(formType) : null,
        cod_amount: fields.amount,
        cod_date: fields.codPeriodFrom,
        cod_period_from: fields.codPeriodFrom,
        cod_period_to: fields.codPeriodTo,
        created_at: nowIso,
        created_by: authorization.userId,
        deposit_date: fields.depositDate,
        deposit_slip_attachments: depositAttachments,
        deposited_amount: fields.amount,
        form_payload: formPayload,
        form_type: formType || null,
        location_id: fields.locationId,
        payment_mode: "CMS / Bank",
        reference_no: fields.remittanceCode,
        remarks: fields.remarks,
        remittance_amount: fields.amount,
        remittance_code: fields.remittanceCode,
        remittance_creation_date: amazon.remittanceCreationDate,
        remittance_submission_date: amazon.remittanceSubmissionDate,
        source: COD_SUBMISSION_SOURCE,
        station_code: station.station_code,
        status: "Submitted",
        submission_no: `COD-${Date.now().toString(36).toUpperCase()}`,
        submitter_name: fields.submitterName,
        updated_at: nowIso,
        validation_status: amazon.validationStatus,
        validated_amount: amazon.validatedAmount,
        validated_at: amazon.validatedAt,
        validation_payload: amazon.validationPayload ?? EMPTY_JSON
      },
      companyId
    );
    let { error } = await supabaseAdmin.from("cod_submissions").insert(insertRow);
    if (error && isMissingFormPayloadColumn(error)) {
      ({ error } = await supabaseAdmin.from("cod_submissions").insert(withoutFormPayload(insertRow)));
    }
    if (error) throw new Error(error.message);

    revalidateCodPaths();
    return {
      ok: true,
      submissionId,
      notice:
        formType === "amazon"
          ? "COD submission saved — remittance verified (deposit = submissionDate, COD period = creationDate, amount, submitter)."
          : "COD submission saved with deposit slip."
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to submit COD proof."
    };
  }
}

export async function updateCodSubmission(
  _prev: CodSubmissionActionState | null,
  formData: FormData
): Promise<CodSubmissionActionState> {
  try {
    const authorization = await requirePagePermission("cod_submission", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

    const submissionId = required(formData.get("submission_id"), "Submission");
    const fields = readCodSubmissionFields(formData);
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(fields.locationId)) {
      throw new Error("You do not have access to the selected station.");
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("cod_submissions")
      .select("id, location_id, form_type, deposit_slip_attachments, attachments")
      .eq("company_id", companyId)
      .eq("id", submissionId)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (!existing) throw new Error("COD submission not found.");
    if (
      !authorization.hasAllLocationAccess &&
      existing.location_id &&
      !authorization.locationScopeIds.includes(existing.location_id)
    ) {
      throw new Error("You do not have access to this submission.");
    }

    const station = await stationDetails(companyId, fields.locationId);
    const formType =
      resolveFormType(station, fields.clientHint) ||
      (existing.form_type === "amazon" || existing.form_type === "flipkart" ? existing.form_type : "");
    const amazon = await amazonValidationOrPending({
      formType,
      stationCode: station.station_code,
      depositDate: fields.depositDate,
      codPeriodFrom: fields.codPeriodFrom,
      codPeriodTo: fields.codPeriodTo,
      remittanceCode: fields.remittanceCode,
      amount: fields.amount,
      submittedBy: fields.submitterName
    });

    const existingAttachments = Array.isArray(existing.deposit_slip_attachments)
      ? (existing.deposit_slip_attachments as CodAttachment[])
      : Array.isArray(existing.attachments)
        ? (existing.attachments as CodAttachment[])
        : [];

    const uploaded = await uploadSlipPhotos(companyId, submissionId, formData);

    const depositAttachments = uploaded.length ? uploaded : existingAttachments;
    if (!depositAttachments.length) {
      throw new Error("Upload a photo of the deposit slip (JPG or PNG).");
    }

    const formPayload = buildFormPayload({
      formType,
      stationCode: station.station_code,
      locationId: fields.locationId,
      remittanceCode: fields.remittanceCode,
      submitterName: fields.submitterName,
      amount: fields.amount,
      depositDate: fields.depositDate,
      codPeriodFrom: fields.codPeriodFrom,
      codPeriodTo: fields.codPeriodTo,
      remarks: fields.remarks
    });

    const updateRow = {
      attachments: depositAttachments,
      client: formType ? clientForFormType(formType) : null,
      cod_amount: fields.amount,
      cod_date: fields.codPeriodFrom,
      cod_period_from: fields.codPeriodFrom,
      cod_period_to: fields.codPeriodTo,
      deposit_date: fields.depositDate,
      deposit_slip_attachments: depositAttachments,
      deposited_amount: fields.amount,
      form_payload: formPayload,
      form_type: formType || null,
      location_id: fields.locationId,
      reference_no: fields.remittanceCode,
      remarks: fields.remarks,
      remittance_amount: fields.amount,
      remittance_code: fields.remittanceCode,
      remittance_creation_date: amazon.remittanceCreationDate,
      remittance_submission_date: amazon.remittanceSubmissionDate,
      source: COD_SUBMISSION_SOURCE,
      station_code: station.station_code,
      submitter_name: fields.submitterName,
      validation_status: amazon.validationStatus,
      validated_amount: amazon.validatedAmount,
      validated_at: amazon.validatedAt,
      validation_payload: amazon.validationPayload ?? EMPTY_JSON,
      updated_at: new Date().toISOString()
    };
    let { error } = await supabaseAdmin
      .from("cod_submissions")
      .update(updateRow)
      .eq("company_id", companyId)
      .eq("id", submissionId);
    if (error && isMissingFormPayloadColumn(error)) {
      ({ error } = await supabaseAdmin
        .from("cod_submissions")
        .update(withoutFormPayload(updateRow))
        .eq("company_id", companyId)
        .eq("id", submissionId));
    }
    if (error) throw new Error(error.message);

    revalidateCodPaths();
    return {
      ok: true,
      submissionId,
      notice:
        formType === "amazon"
          ? "COD submission updated — remittance re-verified."
          : "COD submission updated."
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to update COD submission."
    };
  }
}

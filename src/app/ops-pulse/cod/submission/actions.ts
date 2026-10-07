"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import {
  alphaNumericRequired,
  dateFromForm,
  depositSlipAttachmentFields,
  inferFormTypeFromLocation,
  numberFromForm,
  required,
  requiresRemittanceCheck,
  submitterLooksLikePortalLogin,
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
  const fields = {
    clientHint: String(formData.get("client") ?? "").trim().toLowerCase(),
    locationId: required(formData.get("location_id"), "Station"),
    remittanceCode: alphaNumericRequired(formData.get("remittance_code"), "Remittance code").toUpperCase(),
    // The actual depositor is recorded independently of any portal login.
    submitterName: alphaNumericRequired(formData.get("submitter_name"), "Submitted by"),
    amount: numberFromForm(formData.get("deposited_amount"), "Deposited amount"),
    depositDate: dateFromForm(formData.get("deposit_date"), "Deposit date"),
    codPeriodFrom: dateFromForm(formData.get("cod_period_from"), "COD from date"),
    codPeriodTo: dateFromForm(formData.get("cod_period_to") || formData.get("cod_period_from"), "COD to date"),
    remarks: String(formData.get("remarks") ?? "").trim() || null
  };
  if (fields.amount <= 0) throw new Error("Deposited amount must be greater than zero.");
  for (const date of [fields.depositDate, fields.codPeriodFrom, fields.codPeriodTo]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new Error("Enter valid deposit and COD dates.");
    }
  }
  if (fields.codPeriodFrom > fields.codPeriodTo) throw new Error("COD from date must be on or before COD to date.");
  return fields;
}

// A saved upload is evidence received, not confirmation that cash reconciles.
function pendingRemittanceValidation(reason: string, extra: Record<string, unknown> = {}) {
  return {
    validation_status: "Pending",
    validated_amount: null as number | null,
    validated_at: null as string | null,
    remittance_creation_date: null as string | null,
    remittance_submission_date: null as string | null,
    validation_payload: {
      source: "cod_submission",
      verification: "pending",
      reason,
      ...extra
    } as Record<string, unknown>
  };
}

// Leaves room for the slip upload and the save inside the route's maxDuration
// when the portal check hangs.
const REMITTANCE_VERIFY_BUDGET_MS = 70_000;

function withVerifyBudget<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Amazon portal check did not finish within ${REMITTANCE_VERIFY_BUDGET_MS / 1000}s.`)),
      REMITTANCE_VERIFY_BUDGET_MS
    );
  });
  return Promise.race([work, budget]).finally(() => clearTimeout(timer));
}

type RemittanceOutcome = "verified" | "unavailable" | "not_required";

/**
 * Amazon EDSP/XPT remittances are checked against the portal on every save.
 * A portal answer that does not match blocks the save. Not being able to
 * reach the portal does not: recording a bank slip must never depend on a
 * third-party session, so the slip is saved as Pending and re-checked the
 * next time the row is saved from Edit.
 */
async function remittanceValidation(
  station: CodLocationRow,
  fields: ReturnType<typeof readCodSubmissionFields>
): Promise<{ outcome: RemittanceOutcome; columns: ReturnType<typeof pendingRemittanceValidation> }> {
  if (!requiresRemittanceCheck(station)) {
    return {
      outcome: "not_required",
      columns: pendingRemittanceValidation("Remittance is not checked on the Amazon portal for this station.", {
        portal_check: "not_required"
      })
    };
  }

  const stationCode = String(station.station_code ?? "").trim().toUpperCase();
  if (!stationCode) throw new Error("Selected station is missing a station code.");

  let verify: Awaited<ReturnType<typeof verifyRemittance>>;
  try {
    if (!isCashReconWorkerConfigured()) throw new Error("Cash recon worker is not configured.");
    verify = await withVerifyBudget(
      verifyRemittance({
        stationCode,
        date: fields.depositDate,
        remittanceCode: fields.remittanceCode,
        amount: fields.amount,
        codPeriodFrom: fields.codPeriodFrom,
        codPeriodTo: fields.codPeriodTo,
        fresh: true
      })
    );
  } catch (error) {
    return {
      outcome: "unavailable",
      columns: pendingRemittanceValidation("Amazon portal could not be reached when this slip was saved.", {
        portal_check: "unavailable",
        portal_error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        attempted_at: new Date().toISOString()
      })
    };
  }

  if (!verify.verified) {
    throw new Error(
      verify.failureReason ||
        (!verify.codeFound
          ? `Remittance code ${fields.remittanceCode} was not found on Amazon portal.`
          : `Remittance code found but details do not match for deposit ${fields.depositDate}.`)
    );
  }

  // The portal's submittedBy/createdBy is a login handle (e.g. "dliraja"),
  // not a person. Typing it into "Submitted By" would record a login as the
  // depositor, so it is blocked like a code/amount mismatch.
  const match = verify.matches[0] ?? null;
  if (submitterLooksLikePortalLogin(fields.submitterName, [match?.submittedBy, match?.createdBy])) {
    throw new Error(
      `"${fields.submitterName}" looks like the Amazon portal login, not a person's name. Enter the full name of the person who actually submitted this cash.`
    );
  }

  const checkedAt = new Date().toISOString();
  return {
    outcome: "verified",
    columns: {
      validation_status: "Matched",
      validated_amount: fields.amount,
      validated_at: checkedAt,
      remittance_creation_date: match?.creationDateIst ?? null,
      remittance_submission_date: match?.submissionDateIst ?? null,
      validation_payload: {
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
          checkedAt,
          source: "executive/remittance/verify"
        }
      }
    }
  };
}

function savedNotice(outcome: RemittanceOutcome, verb: "uploaded" | "updated") {
  if (outcome === "verified") {
    return `COD slip ${verb} and remittance verified on the Amazon portal. Your daily update is recorded; slip review is pending.`;
  }
  if (outcome === "unavailable") {
    return `COD slip ${verb} and your daily update is recorded, but the Amazon portal could not be reached, so the remittance is not verified yet. Open Edit on this row and use Verify & save once the portal is back.`;
  }
  return `COD slip ${verb}. Your daily update is recorded; slip review is pending.`;
}

function hasSlipFile(formData: FormData) {
  return depositSlipAttachmentFields.some(([field]) => {
    const file = formData.get(field);
    return typeof file === "object" && file !== null && file.size > 0;
  });
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
  revalidatePath("/cod/pending");
  revalidatePath("/ops-pulse/cod/pending");
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

    // Checked before the portal call and the upload so a blocked remittance
    // neither wastes a portal lookup nor leaves an orphaned slip in storage.
    if (!hasSlipFile(formData)) throw new Error("Upload a photo of the deposit slip (JPG or PNG).");
    const remittance = await remittanceValidation(station, fields);

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
        ai_status: "Review pending",
        ai_summary: null,
        attachments: depositAttachments,
        client: formType ? clientForFormType(formType) : null,
        cod_amount: fields.amount,
        cod_date: fields.codPeriodFrom,
        cod_period_from: fields.codPeriodFrom,
        cod_period_to: fields.codPeriodTo,
        created_at: nowIso,
        created_by: authorization.userId,
        last_updated_by: authorization.userId,
        last_updater_name: authorization.fullName || authorization.email,
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
        source: COD_SUBMISSION_SOURCE,
        station_code: station.station_code,
        status: "Submitted",
        submission_no: `COD-${Date.now().toString(36).toUpperCase()}`,
        submitter_name: fields.submitterName,
        updated_at: nowIso,
        ...remittance.columns
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
      notice: savedNotice(remittance.outcome, "uploaded")
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
      .select("id, location_id, deposit_date, form_type, deposit_slip_attachments, attachments, proof_version, returned_at")
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

    const version=Number(formData.get('proof_version'));
    if(version!==existing.proof_version)throw new Error('This slip changed. Refresh before editing.');
    if(existing.returned_at&&(fields.locationId!==existing.location_id||fields.depositDate!==existing.deposit_date))throw new Error('Keep the original station and deposit date for this returned slip.');
    const station = await stationDetails(companyId, fields.locationId);
    const formType =
      resolveFormType(station, fields.clientHint) ||
      (existing.form_type === "amazon" || existing.form_type === "flipkart" ? existing.form_type : "");

    const existingAttachments = Array.isArray(existing.deposit_slip_attachments)
      ? (existing.deposit_slip_attachments as CodAttachment[])
      : Array.isArray(existing.attachments)
        ? (existing.attachments as CodAttachment[])
        : [];

    if(existing.returned_at&&!hasSlipFile(formData))throw new Error('Upload a replacement photo for this returned slip.');
    const remittance = await remittanceValidation(station, fields);

    const uploaded = await uploadSlipPhotos(companyId, submissionId, formData);

    if(existing.returned_at&&!uploaded.length)throw new Error('Upload a replacement photo for this returned slip.');
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
      last_updated_by: authorization.userId,
      last_updater_name: authorization.fullName || authorization.email,
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
      source: COD_SUBMISSION_SOURCE,
      station_code: station.station_code,
      submitter_name: fields.submitterName,
      ...remittance.columns,
      updated_at: new Date().toISOString()
    };
    let query=supabaseAdmin.from('cod_submissions').update(updateRow).eq('company_id',companyId).eq('id',submissionId).eq('proof_version',version);
    query=existing.returned_at?query.eq('returned_at',existing.returned_at):query.is('returned_at',null);
    const saved=await query.select('id');
    if(!saved.error&&!saved.data?.length)throw new Error('Slip changed while saving. Refresh and try again.');
    let {error}=saved;
    if (error) throw new Error(error.message);

    revalidateCodPaths();
    return {
      ok: true,
      submissionId,
      notice: savedNotice(remittance.outcome, "updated")
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to update COD submission."
    };
  }
}

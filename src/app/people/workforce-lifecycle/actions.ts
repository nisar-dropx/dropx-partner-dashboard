"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { syncBiometricEnrolment } from "@/lib/biometric/enrolments";
import { requireCompanyId } from "@/lib/company-scope";
import { createAppNotification } from "@/lib/app-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";

function lifecycleRedirect(params: { error?: string; notice?: string; tab?: string }): never {
  const query = new URLSearchParams();
  if (params.error) query.set("error", params.error);
  if (params.notice) query.set("notice", params.notice);
  if (params.tab) query.set("tab", params.tab);
  redirect(`/people/workforce-lifecycle${query.size ? `?${query.toString()}` : ""}`);
}

function isRedirect(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

function text(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

async function requireScopedApplicant(id: string) {
  const authorization = await requirePagePermission("people_review", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin
    .from("field_executives")
    .select("id, full_name, location_id, designation, date_of_join, biometric_id, onboarding_status, lifecycle_status")
    .eq("company_id", companyId)
    .eq("id", id)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Workforce applicant was not found.");
  if (!authorization.hasAllLocationAccess &&
      !authorization.locationScopeIds.includes(String(result.data.location_id ?? ""))) {
    throw new Error("You do not have access to this applicant location.");
  }
  return { authorization, companyId, applicant: result.data };
}

async function designationCode(companyId: string, designation: string | null) {
  if (!supabaseAdmin || !designation) return "";
  const result = await supabaseAdmin
    .from("designations")
    .select("code")
    .eq("company_id", companyId)
    .ilike("name", designation)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return String(result.data?.code ?? "").trim().toUpperCase();
}

export async function reviewWorkforceOnboarding(formData: FormData) {
  const id = text(formData.get("id"));
  const action = text(formData.get("review_action")).toLowerCase();
  const remarks = text(formData.get("remarks"));
  try {
    if (!id) throw new Error("Choose an onboarding request.");
    if (!["approve", "return", "reject"].includes(action)) throw new Error("Choose a valid review action.");
    if (["return", "reject"].includes(action) && !remarks) throw new Error("Review remarks are required.");
    const { authorization, companyId, applicant } = await requireScopedApplicant(id);
    if (!["under_review", "returned"].includes(String(applicant.onboarding_status))) {
      throw new Error("Only submitted or returned onboarding requests can be reviewed.");
    }
    const reviewedAt = new Date().toISOString();
    if (action !== "approve") {
      const toStatus = action === "return" ? "returned" : "rejected";
      const update = await supabaseAdmin!.from("field_executives").update({
        onboarding_status: toStatus,
        onboarding_reviewed_at: reviewedAt,
        onboarding_reviewed_by: authorization.userId,
        onboarding_review_remarks: remarks,
        profile_return_remarks: action === "return" ? remarks : null,
        profile_returned_at: action === "return" ? reviewedAt : null,
        is_active: false,
        updated_at: reviewedAt
      }).eq("company_id", companyId).eq("id", id);
      if (update.error) throw new Error(update.error.message);
      const event = await supabaseAdmin!.from("workforce_onboarding_events").insert({
        company_id: companyId,
        field_executive_id: id,
        event_code: action === "return" ? "returned_for_correction" : "onboarding_rejected",
        from_status: applicant.onboarding_status,
        to_status: toStatus,
        actor_user_id: authorization.userId,
        source_portal: "dashboard",
        remarks
      });
      if (event.error) throw new Error(event.error.message);
      revalidatePath("/people/workforce-lifecycle");
      lifecycleRedirect({ notice: action === "return" ? "Application returned for correction." : "Application rejected." });
    }

    const code = await designationCode(companyId, applicant.designation);
    const master = await supabaseAdmin!.from("workforce_onboarding_checklist_master")
      .select("id, code, label, is_required, applicable_designation_codes")
      .eq("company_id", companyId).eq("is_active", true).order("sort_order");
    if (master.error) throw new Error(master.error.message);
    const applicable = (master.data ?? []).filter((item) => {
      const codes = Array.isArray(item.applicable_designation_codes) ? item.applicable_designation_codes : [];
      return !codes.length || codes.map((value) => String(value).toUpperCase()).includes(code);
    });
    const providerId = text(formData.get("provider_employee_id"));
    const providerNotRequired = formData.get("provider_not_required") === "true";
    const results = applicable.map((item) => {
      const checked = formData.get(`checklist_${item.id}`) === "true";
      const status = item.code === "provider_id_created" && providerNotRequired
        ? "not_required"
        : checked ? "completed" : "pending";
      return {
        company_id: companyId,
        field_executive_id: id,
        checklist_item_id: item.id,
        status,
        remarks: item.code === "provider_id_created"
          ? providerId ? `Provider ID: ${providerId}` : providerNotRequired ? "Provider ID not required" : null
          : null,
        completed_by: status === "pending" ? null : authorization.userId,
        completed_at: status === "pending" ? null : reviewedAt,
        updated_at: reviewedAt
      };
    });
    const incomplete = applicable.filter((item, index) => item.is_required && results[index]?.status === "pending");
    if (incomplete.length) throw new Error(`Complete the required checklist: ${incomplete.map((item) => item.label).join(", ")}.`);
    if (results.length) {
      const checklist = await supabaseAdmin!.from("workforce_onboarding_checklist_results")
        .upsert(results, { onConflict: "field_executive_id,checklist_item_id" });
      if (checklist.error) throw new Error(checklist.error.message);
    }
    const approval = await supabaseAdmin!.from("field_executives").update({
      onboarding_status: "active",
      onboarding_reviewed_at: reviewedAt,
      onboarding_reviewed_by: authorization.userId,
      onboarding_review_remarks: remarks || null,
      onboarding_approved_at: reviewedAt,
      onboarding_approved_by: authorization.userId,
      provider_id_status: providerId ? "created" : "not_required",
      provider_employee_id: providerId || null,
      is_active: true,
      lifecycle_status: "active",
      updated_at: reviewedAt
    }).eq("company_id", companyId).eq("id", id);
    if (approval.error) throw new Error(approval.error.message);
    try {
      await syncBiometricEnrolment({
        accountId: id,
        companyId,
        createdBy: authorization.userId,
        effectiveFrom: applicant.date_of_join || reviewedAt.slice(0, 10),
        enrolmentId: applicant.biometric_id,
        fieldExecutiveId: id,
        isActive: true,
        locationId: String(applicant.location_id),
        profileType: "field_executive",
        workerType: "individual_contract"
      });
    } catch (syncError) {
      await supabaseAdmin!.from("field_executives").update({
        onboarding_status: "approved",
        onboarding_activated_at: null,
        is_active: false,
        lifecycle_status: "onboarding",
        updated_at: new Date().toISOString()
      }).eq("company_id", companyId).eq("id", id);
      throw new Error(`Approval was saved, but biometric activation failed. The profile remains inactive: ${syncError instanceof Error ? syncError.message : "Unknown biometric error"}`);
    }
    const event = await supabaseAdmin!.from("workforce_onboarding_events").insert({
      company_id: companyId,
      field_executive_id: id,
      event_code: "ho_approved_and_activated",
      from_status: applicant.onboarding_status,
      to_status: "active",
      actor_user_id: authorization.userId,
      source_portal: "dashboard",
      remarks: remarks || "HO checklist completed and workforce ID activated."
    });
    if (event.error) throw new Error(event.error.message);
    revalidatePath("/people/workforce-lifecycle");
    lifecycleRedirect({ notice: `${applicant.full_name} approved and activated.` });
  } catch (error) {
    if (isRedirect(error)) throw error;
    lifecycleRedirect({ error: error instanceof Error ? error.message : "Unable to review onboarding request." });
  }
}

export async function startWorkforceExit(formData: FormData) {
  const id = text(formData.get("id"));
  const caseType = text(formData.get("case_type")).toLowerCase();
  const effectiveDate = text(formData.get("effective_date"));
  const reasonCode = text(formData.get("reason_code"));
  const reasonDetails = text(formData.get("reason_details"));
  try {
    if (!id || !["resignation", "termination"].includes(caseType)) throw new Error("Choose a valid workforce exit.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new Error("Effective date is required.");
    if (!reasonCode) throw new Error("Exit reason is required.");
    const { authorization, companyId, applicant } = await requireScopedApplicant(id);
    if (String(applicant.lifecycle_status) !== "active") throw new Error("Only active workforce can enter an exit process.");
    const created = await supabaseAdmin!.from("workforce_lifecycle_cases").insert({
      company_id: companyId,
      field_executive_id: id,
      case_type: caseType,
      requested_effective_date: effectiveDate,
      reason_code: reasonCode,
      reason_details: reasonDetails || null,
      initiated_by: authorization.userId,
      initiated_source: "dashboard"
    }).select("id").single();
    if (created.error) throw new Error(created.error.message);
    const nextStatus = caseType === "resignation" ? "resignation_pending" : "termination_pending";
    const update = await supabaseAdmin!.from("field_executives").update({ lifecycle_status: nextStatus, updated_at: new Date().toISOString() })
      .eq("company_id", companyId).eq("id", id);
    if (update.error) throw new Error(update.error.message);
    const event = await supabaseAdmin!.from("workforce_lifecycle_events").insert({
      company_id: companyId,
      lifecycle_case_id: created.data.id,
      field_executive_id: id,
      event_code: `${caseType}_submitted`,
      from_status: "active",
      to_status: "submitted",
      actor_user_id: authorization.userId,
      source_portal: "dashboard",
      remarks: reasonDetails || reasonCode
    });
    if (event.error) throw new Error(event.error.message);
    await createAppNotification({
      accountId: id,
      companyId,
      eventCode: "exit_request_raised",
      profileType: "field_executive",
      sourceKey: String(created.data.id)
    });
    revalidatePath("/people/workforce-lifecycle");
    lifecycleRedirect({ notice: `${caseType === "resignation" ? "Resignation" : "Termination"} case created.`, tab: "exits" });
  } catch (error) {
    if (isRedirect(error)) throw error;
    lifecycleRedirect({ error: error instanceof Error ? error.message : "Unable to start workforce exit.", tab: "active" });
  }
}

export async function reviewWorkforceExit(formData: FormData) {
  const caseId = text(formData.get("case_id"));
  const action = text(formData.get("review_action")).toLowerCase();
  const remarks = text(formData.get("remarks"));
  try {
    const authorization = await requirePagePermission("people_review", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    if (!caseId || !["approve", "reject"].includes(action)) throw new Error("Choose a valid exit decision.");
    if (!remarks) throw new Error("Decision remarks are required.");
    const current = await supabaseAdmin.from("workforce_lifecycle_cases")
      .select("id, field_executive_id, status, requested_effective_date, field_executives(location_id)")
      .eq("company_id", companyId).eq("id", caseId).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data) throw new Error("Exit case was not found.");
    const relation = Array.isArray(current.data.field_executives) ? current.data.field_executives[0] : current.data.field_executives;
    const locationId = String((relation as { location_id?: string } | null)?.location_id ?? "");
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) throw new Error("You do not have access to this location.");
    if (!["submitted", "under_review"].includes(String(current.data.status))) throw new Error("This exit case has already been decided.");
    const now = new Date().toISOString();
    const toStatus = action === "approve" ? "settlement_pending" : "rejected";
    const update = await supabaseAdmin.from("workforce_lifecycle_cases").update({
      status: toStatus,
      reviewed_by: authorization.userId,
      reviewed_at: now,
      review_remarks: remarks,
      approved_by: action === "approve" ? authorization.userId : null,
      approved_at: action === "approve" ? now : null,
      approved_effective_date: action === "approve" ? current.data.requested_effective_date : null,
      updated_at: now
    }).eq("company_id", companyId).eq("id", caseId);
    if (update.error) throw new Error(update.error.message);
    const profileUpdate = await supabaseAdmin.from("field_executives").update({
      lifecycle_status: action === "approve" ? "settlement_pending" : "active",
      updated_at: now
    }).eq("company_id", companyId).eq("id", current.data.field_executive_id);
    if (profileUpdate.error) throw new Error(profileUpdate.error.message);
    await createAppNotification({
      accountId: String(current.data.field_executive_id),
      companyId,
      eventCode: action === "approve" ? "exit_request_approved" : "exit_request_rejected",
      profileType: "field_executive",
      sourceKey: caseId,
      variables: { remarks }
    });
    revalidatePath("/people/workforce-lifecycle");
    lifecycleRedirect({ notice: action === "approve" ? "Exit approved for settlement." : "Exit request rejected.", tab: "exits" });
  } catch (error) {
    if (isRedirect(error)) throw error;
    lifecycleRedirect({ error: error instanceof Error ? error.message : "Unable to review exit.", tab: "exits" });
  }
}

export async function completeWorkforceSettlement(formData: FormData) {
  const caseId = text(formData.get("case_id"));
  try {
    const authorization = await requirePagePermission("people_review", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const current = await supabaseAdmin.from("workforce_lifecycle_cases")
      .select("id, field_executive_id, status, approved_effective_date, requested_effective_date, field_executives(location_id)")
      .eq("company_id", companyId).eq("id", caseId).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data || current.data.status !== "settlement_pending") throw new Error("Choose an exit awaiting settlement.");
    const relation = Array.isArray(current.data.field_executives) ? current.data.field_executives[0] : current.data.field_executives;
    const locationId = String((relation as { location_id?: string } | null)?.location_id ?? "");
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) throw new Error("You do not have access to this location.");
    const masters = await supabaseAdmin.from("workforce_exit_checklist_master").select("id, label, is_required")
      .eq("company_id", companyId).eq("is_active", true).order("sort_order");
    if (masters.error) throw new Error(masters.error.message);
    const now = new Date().toISOString();
    const checklistRows = (masters.data ?? []).map((item) => ({
      company_id: companyId,
      lifecycle_case_id: caseId,
      checklist_item_id: item.id,
      status: formData.get(`exit_checklist_${item.id}`) === "true" ? "completed" : "pending",
      completed_by: formData.get(`exit_checklist_${item.id}`) === "true" ? authorization.userId : null,
      completed_at: formData.get(`exit_checklist_${item.id}`) === "true" ? now : null,
      updated_at: now
    }));
    const incomplete = (masters.data ?? []).filter((item, index) => item.is_required && checklistRows[index]?.status !== "completed");
    if (incomplete.length) throw new Error(`Complete the exit checklist: ${incomplete.map((item) => item.label).join(", ")}.`);
    if (checklistRows.length) {
      const checklist = await supabaseAdmin.from("workforce_exit_checklist_results")
        .upsert(checklistRows, { onConflict: "lifecycle_case_id,checklist_item_id" });
      if (checklist.error) throw new Error(checklist.error.message);
    }
    const settlementStatus = text(formData.get("settlement_status"));
    if (!["paid", "waived"].includes(settlementStatus)) throw new Error("Choose Paid or Waived settlement status.");
    const settlement = await supabaseAdmin.from("workforce_final_settlements").upsert({
      company_id: companyId,
      lifecycle_case_id: caseId,
      status: settlementStatus,
      gross_amount: Number(text(formData.get("gross_amount")) || 0),
      deduction_amount: Number(text(formData.get("deduction_amount")) || 0),
      payment_reference: text(formData.get("payment_reference")) || null,
      payment_date: text(formData.get("payment_date")) || null,
      approved_by: authorization.userId,
      approved_at: now,
      paid_by: settlementStatus === "paid" ? authorization.userId : null,
      paid_at: settlementStatus === "paid" ? now : null,
      updated_at: now
    }, { onConflict: "lifecycle_case_id" });
    if (settlement.error) throw new Error(settlement.error.message);
    const effectiveDate = current.data.approved_effective_date || current.data.requested_effective_date;
    const closeCase = await supabaseAdmin.from("workforce_lifecycle_cases").update({ status: "settled", updated_at: now })
      .eq("company_id", companyId).eq("id", caseId);
    if (closeCase.error) throw new Error(closeCase.error.message);
    const closeProfile = await supabaseAdmin.from("field_executives").update({
      onboarding_status: "cancelled",
      lifecycle_status: "exited",
      last_working_date: effectiveDate,
      deactivated_at: now,
      deactivated_by: authorization.userId,
      is_active: false,
      updated_at: now
    }).eq("company_id", companyId).eq("id", current.data.field_executive_id);
    if (closeProfile.error) throw new Error(closeProfile.error.message);
    await supabaseAdmin.from("biometric_enrolments").update({ status: "Inactive", effective_to: effectiveDate, updated_at: now })
      .eq("company_id", companyId).eq("profile_type", "field_executive")
      .eq("account_id", current.data.field_executive_id).is("effective_to", null);
    revalidatePath("/people/workforce-lifecycle");
    lifecycleRedirect({ notice: "Final settlement recorded and workforce access deactivated.", tab: "exits" });
  } catch (error) {
    if (isRedirect(error)) throw error;
    lifecycleRedirect({ error: error instanceof Error ? error.message : "Unable to complete settlement.", tab: "exits" });
  }
}

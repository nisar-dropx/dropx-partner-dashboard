"use server";

import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { roleIdsWithPageEditAccess } from "@/lib/position-access";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

export async function saveApprovalSteps(formData: FormData) {
  const authorization = await requirePagePermission("payment_settings", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const paymentHeadId = clean(formData.get("payment_head_id"));
  if (!paymentHeadId) throw new Error("Payment head is required.");

  const stepCount = Number(formData.get("step_count") ?? 0);
  const candidateCount = Number(formData.get("candidate_count") ?? 0);

  const steps = [];
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
    const candidates = [];
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
      const roleId = clean(formData.get(`steps[${stepIndex}][candidates][${candidateIndex}][role_id]`));
      if (!roleId) continue;
      const scope = clean(formData.get(`steps[${stepIndex}][candidates][${candidateIndex}][scope]`)) ?? "company";
      candidates.push({ role_id: roleId, scope: ["station", "cluster", "company"].includes(scope) ? scope : "company" });
    }
    if (!candidates.length) continue;
    const isRequired = formData.get(`steps[${stepIndex}][is_required]`) === "1";
    steps.push({ candidates, is_required: isRequired });
  }

  const headResult = await supabaseAdmin
    .from("payment_heads")
    .select("id, code, payment_process_role_ids")
    .eq("company_id", companyId)
    .eq("id", paymentHeadId)
    .maybeSingle();
  if (headResult.error || !headResult.data) throw new Error("Payment head was not found.");

  const roleIds = Array.from(new Set(steps.flatMap((step) => step.candidates.map((candidate) => candidate.role_id))));
  if (roleIds.length) {
    const rolesResult = await supabaseAdmin
      .from("user_roles")
      .select("id, code")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("id", roleIds);
    if (rolesResult.error) throw new Error(rolesResult.error.message);
    if ((rolesResult.data ?? []).length !== roleIds.length) throw new Error("Every approval candidate must be an active role.");

    const financeApprovalCodes = (rolesResult.data ?? [])
      .filter((role) => /(^|_)(FIN|FINMGR|FINANCE|ACCOUNT|ACCOUNTS)(_|$)/.test(String(role.code ?? "").toUpperCase()))
      .map((role) => role.code);
    const isDropxOneReimbursement = headResult.data.code === "EMPLOYEE_REIMBURSEMENT";
    if (financeApprovalCodes.length && !isDropxOneReimbursement) {
      throw new Error("Finance and Accounts roles process payments and cannot be approval candidates.");
    }

    const editableRoleIds = await roleIdsWithPageEditAccess(companyId, roleIds, "payment_approvals");
    const unauthorizedRoleIds = roleIds.filter((roleId) => !editableRoleIds.has(roleId));
    if (unauthorizedRoleIds.length) throw new Error("Every approval candidate must have edit access to Payment Approvals.");
  }

  const processorRoleIds = new Set((headResult.data.payment_process_role_ids ?? []) as string[]);
  const processorApprovers = roleIds.filter((roleId) => processorRoleIds.has(roleId));
  if (processorApprovers.length && headResult.data.code !== "EMPLOYEE_REIMBURSEMENT") {
    throw new Error("Payment-processing roles cannot also be approval candidates. Finance belongs in processing only.");
  }

  const rows = steps.map((step, index) => withCompany({
    payment_head_id: paymentHeadId,
    step_order: index + 1,
    candidates: step.candidates,
    is_required: step.is_required,
    updated_at: new Date().toISOString()
  }, companyId));

  if (rows.length) {
    const { error: upsertError } = await supabaseAdmin
      .from("payment_head_approval_steps")
      .upsert(rows, { onConflict: "payment_head_id,step_order" });
    if (upsertError) throw new Error(upsertError.message);
  }

  let deleteQuery = supabaseAdmin
    .from("payment_head_approval_steps")
    .delete()
    .eq("company_id", companyId)
    .eq("payment_head_id", paymentHeadId);
  deleteQuery = rows.length ? deleteQuery.gt("step_order", rows.length) : deleteQuery;
  const { error: deleteError } = await deleteQuery;
  if (deleteError) throw new Error(deleteError.message);

  const firstRoleIds = steps[0]?.candidates.map((candidate) => candidate.role_id) ?? [];
  const finalRoleIds = steps.at(-1)?.candidates.map((candidate) => candidate.role_id) ?? [];
  const mirrorResult = await supabaseAdmin
    .from("payment_heads")
    .update({
      initial_approval_role_id: firstRoleIds[0] ?? null,
      initial_approval_role_ids: firstRoleIds,
      final_approval_role_id: finalRoleIds[0] ?? null,
      final_approval_role_ids: finalRoleIds,
      updated_at: new Date().toISOString()
    })
    .eq("company_id", companyId)
    .eq("id", paymentHeadId);
  if (mirrorResult.error) throw new Error(mirrorResult.error.message);

  // Approval actions resolve from the current ordered workflow. Keep the
  // cached display total and audit snapshot in sync immediately when that
  // workflow is edited, so existing requests never show impossible progress
  // such as "step 4 of 3". Requests already beyond a newly shortened flow are
  // deliberately left intact for an explicit routing decision.
  if (rows.length) {
    const progressResult = await supabaseAdmin
      .from("payment_requests")
      .update({
        total_steps: rows.length,
        approval_steps_snapshot: steps.map((step, index) => ({
          step_order: index + 1,
          candidates: step.candidates,
          is_required: step.is_required
        })),
        updated_at: new Date().toISOString()
      })
      .eq("company_id", companyId)
      .eq("payment_head_id", paymentHeadId)
      .is("adhoc_approval_steps", null)
      .lte("current_step_order", rows.length)
      .not("status", "in", "(approved,processed,processing,returned,rejected,cancelled)")
      .not("approval_status", "in", "(FINAL_APPROVED,PROCESSED,PROCESSING,RETURNED,REJECTED,CANCELLED)");
    if (progressResult.error) throw new Error(progressResult.error.message);
  }

  revalidatePath(`/settings/payment-approvals/${paymentHeadId}`);
  revalidatePath("/settings/payment-approvals");
  revalidatePath("/master/payment-heads");
  revalidatePath("/payments/approvals");
  revalidatePath("/payments/report");
}

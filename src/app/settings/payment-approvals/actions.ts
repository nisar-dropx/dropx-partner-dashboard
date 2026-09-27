"use server";

import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { loadApprovalSteps, resolveInitialApprovalTarget } from "@/lib/payment-approval-steps";
import { canApplyApprovalChainToOpenRequest, initialStageStatus } from "@/lib/payment-stage-policy";
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

  const { error: deleteError } = await supabaseAdmin
    .from("payment_head_approval_steps")
    .delete()
    .eq("company_id", companyId)
    .eq("payment_head_id", paymentHeadId);
  if (deleteError) throw new Error(deleteError.message);

  if (steps.length) {
    const rows = steps.map((step, index) => withCompany({
      payment_head_id: paymentHeadId,
      step_order: index + 1,
      candidates: step.candidates,
      is_required: step.is_required
    }, companyId));
    const { error: insertError } = await supabaseAdmin.from("payment_head_approval_steps").insert(rows);
    if (insertError) throw new Error(insertError.message);
  }

  if (formData.get("apply_to_unapproved_open_requests") === "1" && steps.length) {
    const configuredSteps = await loadApprovalSteps(companyId, paymentHeadId);
    const requestsResult = await supabaseAdmin
      .from("payment_requests")
      .select("id, location_id, status, approval_status, approval_cycle")
      .eq("company_id", companyId)
      .eq("payment_head_id", paymentHeadId);
    if (requestsResult.error) throw new Error(requestsResult.error.message);

    const requestIds = (requestsResult.data ?? []).map(request => request.id);
    const [canonicalApprovals, legacyApprovals] = requestIds.length
      ? await Promise.all([
          supabaseAdmin
            .from("payment_request_approvals")
            .select("payment_request_id, request_id, action, approval_cycle")
            .eq("company_id", companyId)
            .in("payment_request_id", requestIds),
          supabaseAdmin
            .from("payment_request_approvals")
            .select("payment_request_id, request_id, action, approval_cycle")
            .eq("company_id", companyId)
            .in("request_id", requestIds)
        ])
      : [{ data: [], error: null }, { data: [], error: null }];
    if (canonicalApprovals.error) throw new Error(canonicalApprovals.error.message);
    if (legacyApprovals.error) throw new Error(legacyApprovals.error.message);

    const approvalsByRequest = new Map<string, { action: string | null; approval_cycle: number | null }[]>();
    const approvalRows = [...(canonicalApprovals.data ?? []), ...(legacyApprovals.data ?? [])];
    const seenApprovals = new Set<string>();
    for (const approval of approvalRows) {
      const requestId = approval.payment_request_id ?? approval.request_id;
      if (!requestId) continue;
      const key = `${requestId}:${approval.approval_cycle}:${approval.action}`;
      if (seenApprovals.has(key)) continue;
      seenApprovals.add(key);
      const entries = approvalsByRequest.get(requestId) ?? [];
      entries.push({ action: approval.action, approval_cycle: approval.approval_cycle });
      approvalsByRequest.set(requestId, entries);
    }

    const openRequests = (requestsResult.data ?? []).filter(request =>
      canApplyApprovalChainToOpenRequest(request, approvalsByRequest.get(request.id) ?? [])
    );
    const finalRoleIds = configuredSteps.at(-1)?.candidates.map(candidate => candidate.role_id) ?? [];

    const routing = await Promise.all(openRequests.map(async request => ({
      request,
      target: await resolveInitialApprovalTarget(companyId, configuredSteps, request.location_id)
    })));
    const unresolved = routing.find(entry => !entry.target.approver);
    if (unresolved) {
      throw new Error("The approval chain was saved, but open requests were not re-routed because the first required step has no active approver with payment approval access.");
    }

    const updatedAt = new Date().toISOString();
    for (const { request, target } of routing) {
      const approver = target.approver!;
      const updateResult = await supabaseAdmin
        .from("payment_requests")
        .update({
          status: "pending",
          approval_status: initialStageStatus(approver),
          current_step_order: target.currentStepOrder,
          total_steps: target.totalSteps,
          current_approver_user_id: approver.userId,
          current_approver_role_id: approver.roleId,
          current_approver_role_ids: [approver.roleId],
          final_approval_role_id: finalRoleIds[0] ?? null,
          final_approval_role_ids: finalRoleIds,
          updated_at: updatedAt,
          updated_by: authorization.userId
        })
        .eq("company_id", companyId)
        .eq("id", request.id);
      if (updateResult.error) throw new Error(updateResult.error.message);
    }
  }

  revalidatePath(`/settings/payment-approvals/${paymentHeadId}`);
  revalidatePath("/settings/payment-approvals");
}

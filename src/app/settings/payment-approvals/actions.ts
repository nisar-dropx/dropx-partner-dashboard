"use server";

import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
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

  revalidatePath(`/settings/payment-approvals/${paymentHeadId}`);
  revalidatePath("/settings/payment-approvals");
}

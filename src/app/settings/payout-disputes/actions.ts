"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { roleIdsWithPageEditAccess } from "@/lib/position-access";
import {
  normalizeWorkflowRoleIds,
  PAYOUT_DISPUTE_WORKFLOW_MAX_CANDIDATES,
  validateWorkflowSelection,
  type PayoutDisputeWorkflowSelection
} from "@/lib/payout-dispute-workflow-settings";
import { supabaseAdmin } from "@/lib/supabase-admin";

const PAGE_PATH = "/settings/payout-disputes";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function withMessage(stationId: string | null, key: "error" | "saved" | "removed", message?: string) {
  const params = new URLSearchParams();
  if (stationId) params.set("station", stationId);
  params.set(key, message ?? "1");
  return `${PAGE_PATH}?${params.toString()}`;
}

function selectedRoles(formData: FormData): PayoutDisputeWorkflowSelection {
  const values = (stage: "initial" | "final" | "processor") => normalizeWorkflowRoleIds(
    Array.from({ length: PAYOUT_DISPUTE_WORKFLOW_MAX_CANDIDATES }, (_, index) => formData.get(`${stage}_role_id_${index}`))
  );
  return { initial: values("initial"), final: values("final"), processor: values("processor") };
}

async function validateRoles(companyId: string, selection: PayoutDisputeWorkflowSelection) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const selectionError = validateWorkflowSelection(selection);
  if (selectionError) throw new Error(selectionError);

  const allRoleIds = [...selection.initial, ...selection.final, ...selection.processor];
  const rolesResult = await supabaseAdmin
    .from("user_roles")
    .select("id, name, is_active")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", allRoleIds);
  if (rolesResult.error) throw new Error(rolesResult.error.message);
  if ((rolesResult.data ?? []).length !== allRoleIds.length) {
    throw new Error("Every workflow candidate must be an active role in this company.");
  }

  const [dashboardDisputeEditors, opsDisputeEditors, dashboardPayoutEditors, opsPayoutEditors] = await Promise.all([
    roleIdsWithPageEditAccess(companyId, allRoleIds, "workforce_payout_disputes", true),
    roleIdsWithPageEditAccess(companyId, allRoleIds, "ops_workforce_payout_disputes", true),
    roleIdsWithPageEditAccess(companyId, selection.processor, "workforce_payouts", true),
    roleIdsWithPageEditAccess(companyId, selection.processor, "ops_workforce_payouts", true)
  ]);
  const disputeEditors = new Set([...dashboardDisputeEditors, ...opsDisputeEditors]);
  const missingDisputeAccess = allRoleIds.filter((roleId) => !disputeEditors.has(roleId));
  if (missingDisputeAccess.length) {
    const roleNames = new Map((rolesResult.data ?? []).map((role) => [role.id, role.name]));
    throw new Error(`${missingDisputeAccess.map((id) => roleNames.get(id) ?? id).join(", ")} must have edit access to Payout Disputes.`);
  }

  const processorEditors = new Set(selection.processor.filter((roleId) => (
    dashboardDisputeEditors.has(roleId) && dashboardPayoutEditors.has(roleId)
  ) || (
    opsDisputeEditors.has(roleId) && opsPayoutEditors.has(roleId)
  )));
  const missingPayoutAccess = selection.processor.filter((roleId) => !processorEditors.has(roleId));
  if (missingPayoutAccess.length) {
    const roleNames = new Map((rolesResult.data ?? []).map((role) => [role.id, role.name]));
    throw new Error(`${missingPayoutAccess.map((id) => roleNames.get(id) ?? id).join(", ")} must have edit access to both Payout Disputes and Workforce Payouts on the same Dashboard or Ops portal before being selected as a processor.`);
  }

}

export async function savePayoutDisputeWorkflow(formData: FormData) {
  const authorization = await requirePagePermissionOrThrow("payment_settings", "edit");
  const companyId = requireCompanyId(authorization);
  const stationId = clean(formData.get("station_id"));

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    if (stationId) {
      const stationResult = await supabaseAdmin
        .from("stations")
        .select("id")
        .eq("company_id", companyId)
        .eq("id", stationId)
        .eq("is_active", true)
        .maybeSingle();
      if (stationResult.error) throw new Error(stationResult.error.message);
      if (!stationResult.data) throw new Error("The selected station is not active or was not found.");
      const defaultResult = await supabaseAdmin
        .from("workforce_payout_dispute_workflows")
        .select("id")
        .eq("company_id", companyId)
        .is("station_id", null)
        .eq("is_active", true)
        .maybeSingle();
      if (defaultResult.error) throw new Error(defaultResult.error.message);
      if (!defaultResult.data) throw new Error("Save the company default workflow before adding station overrides.");
    }

    const selection = selectedRoles(formData);
    await validateRoles(companyId, selection);
    const expectedVersion = Number(formData.get("expected_version") ?? 0);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error("Refresh the page and try again.");
    const saveResult = await supabaseAdmin.rpc("workforce_upsert_dispute_workflow", {
      p_company: companyId,
      p_station: stationId,
      p_initial_role_ids: selection.initial,
      p_final_role_ids: selection.final,
      p_processor_role_ids: selection.processor,
      p_actor: authorization.userId,
      p_expected_version: expectedVersion,
      p_is_active: true
    });
    if (saveResult.error) throw new Error(saveResult.error.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The payout dispute workflow could not be saved.";
    redirect(withMessage(stationId, "error", message));
  }

  revalidatePath(PAGE_PATH);
  revalidatePath("/payments/disputes");
  redirect(withMessage(stationId, "saved"));
}

export async function removePayoutDisputeWorkflowOverride(formData: FormData) {
  const authorization = await requirePagePermissionOrThrow("payment_settings", "edit");
  const companyId = requireCompanyId(authorization);
  const stationId = clean(formData.get("station_id"));
  const expectedVersion = Number(formData.get("expected_version") ?? 0);
  if (!stationId) redirect(withMessage(null, "error", "A company default cannot be removed. Replace its role configuration instead."));

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const result = await supabaseAdmin
      .from("workforce_payout_dispute_workflows")
      .delete()
      .eq("company_id", companyId)
      .eq("station_id", stationId)
      .eq("version", expectedVersion)
      .select("id");
    if (result.error) throw new Error(result.error.message);
    if (!result.data?.length) throw new Error("The workflow changed after you opened it. Refresh and try again.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "The station override could not be removed.";
    redirect(withMessage(stationId, "error", message));
  }

  revalidatePath(PAGE_PATH);
  revalidatePath("/payments/disputes");
  redirect(withMessage(null, "removed"));
}


import "server-only";
import { mayActivateRedispute } from "./loss-recovery-controls";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadActiveApprovalCovers } from "@/lib/approval-covers";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { holdApprovers } from "./salary-hold-policy";
import { recoveryContext } from "./nl-recovery-context";
import {
  clusterMayAct,
  slpMayAct,
  stationMayAct,
  type LifecycleAction,
} from "./nl-loss-lifecycle-policy";

export function canEditLossRecoveryMaster(auth: AuthorizationContext) {
  return !auth.readOnly && hasPermission(auth, "ops_loss_master", "edit");
}

export function canViewLosses(auth: AuthorizationContext) {
  return hasPermission(auth, "ops_losses", "access");
}

/** Station-scoped Losses access without Master edit: view + clarify/dispute only. */
export function isStationLossActor(auth: AuthorizationContext) {
  return canViewLosses(auth) && !canEditLossRecoveryMaster(auth);
}

export async function lossLifecycleActors(
  auth: AuthorizationContext,
  stationId: string,
) {
  const company = auth.companyId!;
  const [hierarchy, covers, links] = await Promise.all([
    loadPeopleOperationalHierarchy(company, [stationId], {
      includeStationResponsibilities: true,
    }),
    loadActiveApprovalCovers(company),
    supabaseAdmin!
      .from("hr_user_person_links")
      .select("person_id")
      .eq("company_id", company)
      .eq("user_id", auth.userId)
      .eq("status", "active"),
  ]);
  if (hierarchy.error) throw Error("People hierarchy could not be loaded.");
  const viewerPeople = new Set((links.data ?? []).map((r) => r.person_id as string));
  const approvers = holdApprovers(
    hierarchy.byLocation.get(stationId),
    new Set(),
    covers,
  );
  const isCluster =
    !auth.readOnly && approvers.personIds.some((id) => viewerPeople.has(id));
  const isSlp = mayActivateRedispute(auth) && hasPermission(auth, "ops_losses", "edit");
  return {
    isCluster,
    isSlp,
    approvers,
    isStationOnly: isStationLossActor(auth) && !isCluster,
  };
}

export async function assertLifecycleAction(
  auth: AuthorizationContext,
  stationId: string,
  action: LifecycleAction,
  proposedBy?: string | null,
) {
  if (action === "propose") {
    if (auth.readOnly || !hasPermission(auth, "ops_losses", "edit")) throw Error("Loss recovery edit access is required to submit an update.");
    return {isCluster:false,isSlp:mayActivateRedispute(auth),isStationOnly:true};
  }
  const actors = await lossLifecycleActors(auth, stationId);
  if (action === "clarify" && (actors.isStationOnly || actors.isCluster || actors.isSlp)) {
    if (!stationMayAct(action) && !actors.isCluster && !actors.isSlp) {
      throw Error("You do not have access to raise a clarification.");
    }
    return actors;
  }
  if (action === "approve") {
    if (!actors.isSlp) throw Error("Only SLP Manager, National Head, Finance Manager or Managing Partner can approve this recovery.");
    if (proposedBy && auth.userId && proposedBy === auth.userId) {
      throw Error("You proposed this recovery, so another authorised person must approve it.");
    }
    return actors;
  }
  if (action === "reject") throw Error("Return the update for correction; an unpaid loss cannot be rejected.");
  if (clusterMayAct(action) && (actors.isCluster || actors.isSlp)) return actors;
  if (slpMayAct(action) && actors.isSlp) return actors;
  throw Error("You do not have access to perform this loss lifecycle action.");
}

export async function transitionLossLifecycle(input: {
  auth: AuthorizationContext;
  month: string;
  caseKey: string;
  action: string;
  version: number;
  note?: string | null;
}) {
  const ctx = await recoveryContext(input.month, input.caseKey, true);
  const action = input.action as LifecycleAction;
  await assertLifecycleAction(ctx.auth, ctx.station.id, action);
  const { data, error } = await supabaseAdmin!.rpc("nl_loss_lifecycle_transition", {
    p_company: ctx.scope.company,
    p_month: input.month,
    p_case: ctx.caseKey,
    p_action: input.action,
    p_version: input.version,
    p_actor: ctx.auth.userId,
    p_name: ctx.auth.fullName || ctx.auth.email || "Ops",
    p_note: input.note ?? null,
  });
  if (error) throw Error(error.message);
  return data;
}

export async function approveLossRecovery(input: {
  auth: AuthorizationContext;
  month: string;
  caseKey: string;
  version: number;
  lifecycleVersion: number;
  note?: string | null;
}) {
  const ctx = await recoveryContext(input.month, input.caseKey, true);
  const plan = await supabaseAdmin!
    .from("nl_loss_recoveries")
    .select("proposed_by,approval_status")
    .eq("company_id", ctx.scope.company)
    .eq("month", input.month)
    .eq("case_key", ctx.caseKey)
    .maybeSingle();
  await assertLifecycleAction(
    ctx.auth,
    ctx.station.id,
    "approve",
    plan.data?.proposed_by ?? null,
  );
  const { data, error } = await supabaseAdmin!.rpc("nl_loss_recovery_approve", {
    p_company: ctx.scope.company,
    p_month: input.month,
    p_case: ctx.caseKey,
    p_version: input.version,
    p_actor: ctx.auth.userId,
    p_name: ctx.auth.fullName || ctx.auth.email || "Ops",
    p_note: input.note ?? null,
    p_lifecycle_version: input.lifecycleVersion,
  });
  if (error) throw Error(error.message);
  return data;
}

export async function submitLossClarification(input: {
  auth: AuthorizationContext;
  month: string;
  caseKey: string;
  note: string;
  reason?: string;
  category?: string;
  employeeRef?: string | null;
  evidenceUrl?: string | null;
  source?: "station" | "associate" | "cluster";
}) {
  const ctx = await recoveryContext(input.month, input.caseKey, false);
  // Portal/station clarifications need Losses edit. Associate source is only for
  // DropX One (Connect), which authenticates the person separately.
  if (input.source !== "associate" && !hasPermission(ctx.auth, "ops_losses", "edit")) {
    throw Error("Access denied.");
  }
  if (input.source === "associate") {
    throw Error("Associate clarifications must be submitted from DropX One.");
  }
  const { data, error } = await supabaseAdmin!.rpc("nl_loss_clarification_submit", {
    p_company: ctx.scope.company,
    p_month: input.month,
    p_case: ctx.caseKey,
    p_actor: ctx.auth.userId,
    p_name: ctx.auth.fullName || ctx.auth.email || "Ops",
    p_note: input.note,
    p_reason: input.reason ?? "",
    p_category: input.category ?? "clarification",
    p_employee_ref: input.employeeRef ?? null,
    p_evidence_url: input.evidenceUrl ?? null,
    p_attachments: [],
    p_source: input.source ?? "station",
  });
  if (error) throw Error(error.message);
  return data;
}

"use server";

import { revalidatePath } from "next/cache";
import { hasPermission, requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function db() {
  if (!supabaseAdmin) throw new Error("Offboarding checklist service unavailable.");
  return supabaseAdmin;
}

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Walks hr_reporting_relationships from the worker's own current work
 * assignment upward, same as dropx-hrms/src/lib/exit-case-instantiation.ts's
 * reportingManagerUserAtLevel, so the server-side re-check uses the exact
 * same manager-chain semantics as the read side (offboarding-checklist-data.ts).
 */
async function reportingManagerAssignmentChain(companyId: string, subjectAssignmentId: string) {
  const day = indiaToday();
  const chain: string[] = [];
  const seen = new Set<string>([subjectAssignmentId]);
  let currentId = subjectAssignmentId;
  for (let depth = 0; depth < 8; depth += 1) {
    const relationship = await db()
      .from("hr_reporting_relationships")
      .select("manager_assignment_id")
      .eq("company_id", companyId)
      .eq("subject_assignment_id", currentId)
      .eq("relationship_type", "solid_line")
      .eq("is_primary", true)
      .lte("effective_from", day)
      .or(`effective_to.is.null,effective_to.gte.${day}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (relationship.error || !relationship.data?.manager_assignment_id) break;
    const managerAssignmentId = relationship.data.manager_assignment_id as string;
    if (seen.has(managerAssignmentId)) break;
    seen.add(managerAssignmentId);
    chain.push(managerAssignmentId);
    currentId = managerAssignmentId;
  }
  return chain;
}

async function currentAssignmentIdsForUser(companyId: string, userId: string) {
  const linkResult = await db().from("hr_user_person_links").select("person_id")
    .eq("company_id", companyId).eq("user_id", userId).eq("status", "active");
  const personIds = [...new Set((linkResult.data ?? []).map((row) => row.person_id).filter(Boolean))];
  if (!personIds.length) return new Set<string>();
  const day = indiaToday();
  const engagementsResult = await db().from("hr_engagements").select("id")
    .eq("company_id", companyId).eq("status", "active").in("person_id", personIds);
  const engagementIds = (engagementsResult.data ?? []).map((row) => row.id);
  if (!engagementIds.length) return new Set<string>();
  const assignmentsResult = await db().from("hr_work_assignments").select("id")
    .eq("company_id", companyId).eq("is_primary", true).in("engagement_id", engagementIds)
    .lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`);
  return new Set((assignmentsResult.data ?? []).map((row) => row.id));
}

async function subjectAssignmentIdForWorker(companyId: string, workerType: "employee" | "contractor", workerId: string) {
  const day = indiaToday();
  let engagementQuery = db().from("hr_engagements").select("id").eq("company_id", companyId).eq("status", "active")
    .order("start_date", { ascending: false }).limit(1);
  engagementQuery = workerType === "employee" ? engagementQuery.eq("employee_id", workerId) : engagementQuery.eq("contractor_id", workerId);
  const engagement = await engagementQuery.maybeSingle();
  if (!engagement.data) return null;
  const assignment = await db().from("hr_work_assignments").select("id")
    .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  return assignment.data?.id ?? null;
}

/**
 * Approves/rejects/skips one hr_exit_task_approvals row on behalf of the
 * signed-in manager. Every check the client-side UI already applies is
 * re-verified here against fresh data, since the client's view of "who can
 * act" and "is this gate unlocked" is only ever advisory:
 *  - the actor genuinely holds the approval level today (REPORTING_MANAGER
 *    levels via manager-chain depth matching, HR_MANAGER/other levels via the
 *    ops_offboarding_checklist "edit" permission - the same first-version
 *    simplification used in offboarding-checklist-data.ts)
 *  - every lower-sequence_order level for the same task_id is already approved
 *  - a proof_note is present when the template's mandatory_proof is set and
 *    the action is "approve"
 * On success, if this update leaves every approval row for the task
 * "approved", the parent hr_exit_tasks.status is set to "completed". A
 * "reject" action instead sets the task to "blocked" (chosen over "waived" -
 * "waived" implies the requirement was deliberately excused without ever being
 * satisfied, which is a distinct HR decision; "blocked" better reflects "this
 * checklist item hit a rejected gate and cannot proceed until someone
 * intervenes", matching the hr_exit_tasks status enum's intent). This is a
 * judgment call flagged for HRMS-side confirmation.
 */
export async function actOnOffboardingTaskApproval(formData: FormData): Promise<ActionResult> {
  let auth;
  try {
    auth = await requirePagePermissionOrThrow("ops_offboarding_checklist", "access");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sign-in could not be verified." };
  }

  const approvalId = String(formData.get("approvalId") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const proofNote = String(formData.get("proofNote") ?? "").trim();
  if (!approvalId || !["approved", "rejected", "skipped"].includes(decision)) {
    return { ok: false, message: "Invalid approval action." };
  }

  try {
    const companyId = requireCompanyId(auth);

    const approvalResult = await db().from("hr_exit_task_approvals")
      .select("id,task_id,approval_level_id,sequence_order,status,company_id")
      .eq("id", approvalId).eq("company_id", companyId).maybeSingle();
    if (approvalResult.error || !approvalResult.data) return { ok: false, message: "Approval gate could not be found." };
    const approval = approvalResult.data;
    if (approval.status !== "pending") return { ok: false, message: "This approval level has already been actioned." };

    const taskResult = await db().from("hr_exit_tasks")
      .select("id,case_id,template_id,status")
      .eq("id", approval.task_id).eq("company_id", companyId).maybeSingle();
    if (taskResult.error || !taskResult.data) return { ok: false, message: "Checklist task could not be found." };
    const task = taskResult.data;

    const caseResult = await db().from("hr_exit_cases")
      .select("id,worker_type,employee_id,contractor_id,status")
      .eq("id", task.case_id).eq("company_id", companyId).maybeSingle();
    if (caseResult.error || !caseResult.data) return { ok: false, message: "Exit case could not be found." };
    const exitCase = caseResult.data;
    const workerId = exitCase.worker_type === "contractor" ? exitCase.contractor_id : exitCase.employee_id;
    if (!workerId) return { ok: false, message: "Exit case is missing a worker reference." };

    const levelResult = await db().from("hr_exit_task_approval_levels")
      .select("id,approver_role").eq("id", approval.approval_level_id).eq("company_id", companyId).maybeSingle();
    if (levelResult.error || !levelResult.data) return { ok: false, message: "Approval level could not be found." };
    const level = levelResult.data;

    // Re-check: actor genuinely holds this level today.
    let actorEligible = false;
    if (level.approver_role === "REPORTING_MANAGER") {
      const allGatesResult = await db().from("hr_exit_task_approvals")
        .select("id,approval_level_id,sequence_order").eq("task_id", task.id).eq("company_id", companyId)
        .order("sequence_order", { ascending: true });
      if (allGatesResult.error) return { ok: false, message: "Approval gates could not be loaded." };
      const levelIds = [...new Set((allGatesResult.data ?? []).map((row) => row.approval_level_id))];
      const levelsResult = await db().from("hr_exit_task_approval_levels")
        .select("id,approver_role,sequence_order").in("id", levelIds).eq("company_id", companyId);
      if (levelsResult.error) return { ok: false, message: "Approval levels could not be loaded." };
      const levelById = new Map((levelsResult.data ?? []).map((row) => [row.id, row]));
      const reportingManagerLevelsInOrder = [...levelById.values()]
        .filter((lvl) => lvl.approver_role === "REPORTING_MANAGER")
        .sort((a, b) => a.sequence_order - b.sequence_order);
      const depth = reportingManagerLevelsInOrder.findIndex((lvl) => lvl.id === level.id);

      const subjectAssignmentId = await subjectAssignmentIdForWorker(companyId, exitCase.worker_type, workerId);
      if (subjectAssignmentId && depth >= 0) {
        const managerChain = await reportingManagerAssignmentChain(companyId, subjectAssignmentId);
        const requiredAssignmentId = managerChain[depth];
        if (requiredAssignmentId) {
          const viewerAssignmentIds = await currentAssignmentIdsForUser(companyId, auth.userId);
          actorEligible = viewerAssignmentIds.has(requiredAssignmentId);
        }
      }
    } else {
      actorEligible = hasPermission(auth, "ops_offboarding_checklist", "edit");
    }
    if (!actorEligible) return { ok: false, message: "You do not hold this approval level for this person." };

    // Re-check: sequential gate - every lower-sequence_order level must already be approved.
    const priorGatesResult = await db().from("hr_exit_task_approvals")
      .select("status").eq("task_id", task.id).eq("company_id", companyId).lt("sequence_order", approval.sequence_order);
    if (priorGatesResult.error) return { ok: false, message: "Prior approval gates could not be verified." };
    if ((priorGatesResult.data ?? []).some((row) => row.status !== "approved")) {
      return { ok: false, message: "Earlier approval levels for this task must be cleared first." };
    }

    // Re-check: mandatory proof required before an "approved" decision.
    if (decision === "approved" && task.template_id) {
      const templateResult = await db().from("hr_exit_task_templates").select("mandatory_proof")
        .eq("id", task.template_id).eq("company_id", companyId).maybeSingle();
      if (templateResult.error) return { ok: false, message: "Task template could not be verified." };
      if (templateResult.data?.mandatory_proof && !proofNote) {
        return { ok: false, message: "This task requires proof. Add a proof note before approving." };
      }
    }
    if (decision === "approved" && !proofNote) {
      return { ok: false, message: "Add a proof note before approving." };
    }

    const actedAt = new Date().toISOString();
    const updateResult = await db().from("hr_exit_task_approvals").update({
      status: decision,
      approver_user_id: auth.userId,
      proof_note: proofNote || null,
      acted_by: auth.userId,
      acted_at: actedAt
    }).eq("id", approval.id).eq("company_id", companyId).eq("status", "pending");
    if (updateResult.error) return { ok: false, message: "Approval could not be saved." };

    const remainingGatesResult = await db().from("hr_exit_task_approvals").select("status")
      .eq("task_id", task.id).eq("company_id", companyId);
    if (remainingGatesResult.error) return { ok: false, message: "Task status could not be refreshed." };
    const gateStatuses = (remainingGatesResult.data ?? []).map((row) => row.status);
    let nextTaskStatus: string | null = null;
    if (decision === "rejected") {
      nextTaskStatus = "blocked";
    } else if (gateStatuses.length && gateStatuses.every((status) => status === "approved")) {
      nextTaskStatus = "completed";
    } else if (task.status === "pending") {
      nextTaskStatus = "in_progress";
    }
    if (nextTaskStatus && nextTaskStatus !== task.status) {
      const taskUpdate = await db().from("hr_exit_tasks").update({
        status: nextTaskStatus,
        completed_by: nextTaskStatus === "completed" ? auth.userId : undefined,
        completed_at: nextTaskStatus === "completed" ? actedAt : undefined
      }).eq("id", task.id).eq("company_id", companyId);
      if (taskUpdate.error) return { ok: false, message: "Approval saved, but the task status could not be updated." };
    }

    revalidatePath("/attendance/offboarding");
    return { ok: true, message: decision === "approved" ? "Approval recorded." : decision === "rejected" ? "Rejection recorded." : "Level skipped." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The approval action could not be completed." };
  }
}

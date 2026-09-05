import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { notifyEmployeeExitSubmitted, notifyEmployeeExitWithdrawal, notifyExitApprovalRequired, notifyExitWithdrawalReviewer } from "../../../../src/lib/connect-exit-notifications";
import { createAppNotification } from "../../../../src/lib/app-notifications";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import { todayInIndia } from "../../../../src/lib/india-date";

type PeopleProfileType = "employee" | "user" | "contractor";
type WorkerContext = {
  account: ConnectAccount;
  workerType: "employee" | "contractor";
  workerId: string;
  worker: {
    employee_code: string | null;
    full_name: string;
    email: string | null;
    mobile: string | null;
    is_active: boolean;
  };
};

type ApprovalRouteRow = {
  company_id: string;
  workflow_step_id: string;
  step_order: number;
  step_name: string;
  approver_role: string;
  approver_source: "reporting_manager" | "role";
  hierarchy_level: number | null;
  approver_role_id: string | null;
  assigned_user_id: string | null;
  is_required: boolean;
};

type ApprovalRoutePreview = {
  stepOrder: number;
  stepName: string;
  approverName: string;
  detail: string;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  return supabaseAdmin;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isPeopleProfileType(value: string): value is PeopleProfileType {
  return ["employee", "user", "contractor"].includes(value);
}

async function resolveWorker(profileType: string, accountId: string): Promise<WorkerContext> {
  if (!isPeopleProfileType(profileType)) throw new Error("This role is managed through Workforce lifecycle.");
  const account = await requireConnectAccount(profileType, accountId);

  if (profileType === "contractor") {
    const { data, error } = await db().from("contractors")
      .select("id, dropx_id, full_name, email, mobile, is_active, lifecycle_status")
      .eq("company_id", account.companyId)
      .eq("id", account.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Independent contractor profile is unavailable.");
    return {
      account,
      workerType: "contractor",
      workerId: data.id,
      worker: {
        employee_code: data.dropx_id,
        full_name: data.full_name,
        email: data.email,
        mobile: data.mobile,
        is_active: Boolean(data.is_active) && !["deactivated", "settled"].includes(String(data.lifecycle_status ?? "active"))
      }
    };
  }

  let employeeId = account.id;
  if (profileType === "user") {
    const { data: profile, error: profileError } = await db().from("profiles")
      .select("employee_id")
      .eq("company_id", account.companyId)
      .eq("id", account.id)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile?.employee_id) throw new Error("This People user is not linked to an employee profile.");
    const { data: employee, error: employeeError } = await db().from("employees")
      .select("id")
      .eq("company_id", account.companyId)
      .eq("employee_code", profile.employee_id)
      .maybeSingle();
    if (employeeError) throw new Error(employeeError.message);
    if (!employee) throw new Error("The linked employee profile is unavailable.");
    employeeId = employee.id;
  }

  const { data, error } = await db().from("employees")
    .select("id, employee_code, full_name, email, mobile, is_active")
    .eq("company_id", account.companyId)
    .eq("id", employeeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Employee profile is unavailable.");
  return {
    account,
    workerType: "employee",
    workerId: data.id,
    worker: {
      employee_code: data.employee_code,
      full_name: data.full_name,
      email: data.email,
      mobile: data.mobile,
      is_active: Boolean(data.is_active)
    }
  };
}

async function reportingManagerChain(context: WorkerContext, levels: number) {
  const sourceColumn = context.workerType === "contractor" ? "contractor_id" : "employee_id";
  const today = todayInIndia();
  const { data: engagement } = await db().from("hr_engagements")
    .select("id")
    .eq("company_id", context.account.companyId)
    .eq(sourceColumn, context.workerId)
    .eq("status", "active")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const chain: Array<{ userId: string; name: string; positionTitle: string | null }> = [];
  if (engagement) {
    const { data: assignment } = await db().from("hr_work_assignments")
      .select("id")
      .eq("company_id", context.account.companyId)
      .eq("engagement_id", engagement.id)
      .eq("is_primary", true)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (assignment) {
      let subjectAssignmentId = assignment.id;
      const seenAssignments = new Set<string>([assignment.id]);
      for (let level = 1; level <= levels; level += 1) {
        const { data: relationship } = await db().from("hr_reporting_relationships")
        .select("manager_assignment_id")
        .eq("company_id", context.account.companyId)
        .eq("subject_assignment_id", subjectAssignmentId)
        .eq("relationship_type", "solid_line")
        .eq("is_primary", true)
        .lte("effective_from", today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle();
        if (!relationship?.manager_assignment_id || seenAssignments.has(relationship.manager_assignment_id)) break;
        seenAssignments.add(relationship.manager_assignment_id);
        const { data: managerAssignment } = await db().from("hr_work_assignments")
          .select("id, engagement_id, position_title")
          .eq("company_id", context.account.companyId)
          .eq("id", relationship.manager_assignment_id)
          .maybeSingle();
        if (managerAssignment) {
          const { data: managerEngagement } = await db().from("hr_engagements")
            .select("person_id")
            .eq("company_id", context.account.companyId)
            .eq("id", managerAssignment.engagement_id)
            .maybeSingle();
          if (managerEngagement) {
            const [{ data: link }, { data: person }] = await Promise.all([
              db().from("hr_user_person_links")
              .select("user_id")
              .eq("company_id", context.account.companyId)
              .eq("person_id", managerEngagement.person_id)
              .eq("status", "active")
              .maybeSingle(),
              db().from("hr_people").select("display_name").eq("company_id", context.account.companyId).eq("id", managerEngagement.person_id).maybeSingle()
            ]);
            if (!link?.user_id) break;
            chain.push({ userId: link.user_id, name: person?.display_name ?? `Manager level ${level}`, positionTitle: managerAssignment.position_title });
            subjectAssignmentId = managerAssignment.id;
            continue;
          }
        }
        break;
      }
    }
  }

  if (!chain.length && context.workerType === "employee" && context.worker.employee_code && levels > 0) {
    const { data: profile } = await db().from("profiles")
      .select("reports_to_user_id")
      .eq("company_id", context.account.companyId)
      .eq("employee_id", context.worker.employee_code)
      .maybeSingle();
    if (profile?.reports_to_user_id) {
      const { data: manager } = await db().from("profiles").select("id, full_name").eq("company_id", context.account.companyId).eq("id", profile.reports_to_user_id).eq("is_active", true).maybeSingle();
      if (manager) chain.push({ userId: manager.id, name: manager.full_name ?? "Reporting manager", positionTitle: null });
    }
  }
  return chain;
}

async function activeRoleUsers(companyId: string, roleId: string) {
  const today = todayInIndia();
  const [{ data: grants }, { data: legacy }] = await Promise.all([
    db().from("hr_access_grants").select("user_id").eq("company_id", companyId).eq("role_id", roleId).eq("is_active", true).lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`),
    db().from("hr_user_access").select("user_id").eq("company_id", companyId).eq("role_id", roleId).eq("is_active", true)
  ]);
  const userIds = [...new Set([...(grants ?? []), ...(legacy ?? [])].map((row) => row.user_id))];
  if (!userIds.length) return [];
  const { data } = await db().from("profiles").select("id, full_name, email").eq("company_id", companyId).eq("is_active", true).in("id", userIds);
  return data ?? [];
}

async function activeApprovalUserIds(companyId: string) {
  const { data: page } = await db().from("hr_permission_pages").select("id").eq("company_id", companyId).eq("code", "approvals").eq("is_active", true).maybeSingle();
  if (!page) return new Set<string>();
  const { data: permissions } = await db().from("hr_role_page_permissions").select("role_id").eq("company_id", companyId).eq("page_id", page.id).eq("can_approve", true);
  const roleIds = [...new Set((permissions ?? []).map((row) => row.role_id))];
  if (!roleIds.length) return new Set<string>();
  const today = todayInIndia();
  const [{ data: grants }, { data: legacy }] = await Promise.all([
    db().from("hr_access_grants").select("user_id").eq("company_id", companyId).in("role_id", roleIds).eq("is_active", true).lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`),
    db().from("hr_user_access").select("user_id").eq("company_id", companyId).in("role_id", roleIds).eq("is_active", true)
  ]);
  return new Set([...(grants ?? []), ...(legacy ?? [])].map((row) => row.user_id));
}

async function configuredApprovalRoute(context: WorkerContext, scenario: string) {
  const { data: storedSteps, error } = await db().from("hr_exit_workflow_steps")
    .select("*, hr_roles(code, name)")
    .eq("company_id", context.account.companyId)
    .in("scenario", [scenario, "all"])
    .eq("is_active", true)
    .order("step_order");
  if (error) throw new Error(error.message);
  const directSteps = (storedSteps ?? []).filter((step) => step.scenario === scenario);
  const steps = directSteps.length ? directSteps : (storedSteps ?? []).filter((step) => step.scenario === "all");
  if (!steps.length) throw new Error("No approval workflow is active for resignations. Configure it in Offboarding Masters.");
  const highestLevel = steps.reduce((maximum, step) => step.approver_source === "reporting_manager" ? Math.max(maximum, Number(step.hierarchy_level ?? 0)) : maximum, 0);
  const [managerChain, approvalUsers] = await Promise.all([reportingManagerChain(context, highestLevel), activeApprovalUserIds(context.account.companyId)]);
  const rows: ApprovalRouteRow[] = [];
  const preview: ApprovalRoutePreview[] = [];
  for (const step of steps) {
    const source = step.approver_source === "role" ? "role" : "reporting_manager";
    if (source === "reporting_manager") {
      const hierarchyLevel = Number(step.hierarchy_level ?? 0);
      const manager = hierarchyLevel > 0 ? managerChain[hierarchyLevel - 1] : null;
      if (!manager) {
        if (step.unavailable_behavior === "skip") continue;
        throw new Error(`${step.name} cannot be resolved from the current reporting hierarchy. Update the employee's reporting line or change this step's fallback in Offboarding Masters.`);
      }
      if (!approvalUsers.has(manager.userId)) throw new Error(`${manager.name} is in the reporting route but does not have Approval Inbox approval access. Update the manager's role access or this workflow step in Offboarding Masters.`);
      rows.push({ company_id: context.account.companyId, workflow_step_id: step.id, step_order: step.step_order, step_name: step.name, approver_role: "REPORTING_MANAGER", approver_source: source, hierarchy_level: hierarchyLevel, approver_role_id: null, assigned_user_id: manager.userId, is_required: step.is_required });
      preview.push({ stepOrder: step.step_order, stepName: step.name, approverName: manager.name, detail: manager.positionTitle || `Reporting hierarchy level ${hierarchyLevel}` });
      continue;
    }
    if (!step.approver_role_id) {
      if (step.unavailable_behavior === "skip") continue;
      throw new Error(`${step.name} does not have an approver role selected in Offboarding Masters.`);
    }
    const roleUsers = await activeRoleUsers(context.account.companyId, step.approver_role_id);
    const roleRelation = Array.isArray(step.hr_roles) ? step.hr_roles[0] : step.hr_roles;
    if (!roleUsers.length) {
      if (step.unavailable_behavior === "skip") continue;
      throw new Error(`${roleRelation?.name ?? step.name} has no active user assignment. Assign the role in Users & Access or update Offboarding Masters.`);
    }
    rows.push({ company_id: context.account.companyId, workflow_step_id: step.id, step_order: step.step_order, step_name: step.name, approver_role: "CONFIGURED_ROLE", approver_source: source, hierarchy_level: null, approver_role_id: step.approver_role_id, assigned_user_id: null, is_required: step.is_required });
    preview.push({ stepOrder: step.step_order, stepName: step.name, approverName: roleRelation?.name ?? "Configured People role", detail: `${roleUsers.length} active approver${roleUsers.length === 1 ? "" : "s"}` });
  }
  if (!rows.length) throw new Error("The configured workflow does not resolve to an active approval step.");
  return { rows, preview, firstManagerId: rows.find((row) => row.approver_source === "reporting_manager")?.assigned_user_id ?? null };
}

async function taskOwnerUser(context: WorkerContext, role: string) {
  if (role === "REPORTING_MANAGER") return (await reportingManagerChain(context, 1))[0]?.userId ?? null;
  const { data: storedRole } = await db().from("hr_roles").select("id").eq("company_id", context.account.companyId).eq("code", role).eq("is_active", true).maybeSingle();
  if (storedRole) return (await activeRoleUsers(context.account.companyId, storedRole.id))[0]?.id ?? null;
  return null;
}

function caseQuery(context: WorkerContext) {
  const query = db().from("hr_exit_cases")
    .select("*, hr_exit_reasons(name)")
    .eq("company_id", context.account.companyId)
    .eq("worker_type", context.workerType);
  return context.workerType === "contractor"
    ? query.eq("contractor_id", context.workerId)
    : query.eq("employee_id", context.workerId);
}

async function serializeCase(row: Record<string, any>) {
  const [{ data: tasks }, { data: documents }, { data: events }, { data: approvals }] = await Promise.all([
    db().from("hr_exit_tasks").select("id, category, name, due_date, status, is_required").eq("case_id", row.id).order("created_at"),
    db().from("hr_exit_documents").select("id, document_type, file_name, status, generated_at, storage_path").eq("case_id", row.id).neq("status", "void").order("generated_at", { ascending: false }),
    db().from("hr_exit_events").select("id, event_code, title, actor_name, created_at, details").eq("case_id", row.id).order("created_at"),
    db().from("hr_exit_approvals").select("id, step_order, step_name, approver_role, approver_source, hierarchy_level, approver_role_id, assigned_user_id, status, comments, acted_at, created_at, hr_roles(name)").eq("case_id", row.id).order("step_order")
  ]);
  const safeDocuments = await Promise.all((documents ?? []).map(async (document) => {
    if (!document.storage_path) return { id: document.id, type: document.document_type, name: document.file_name, status: document.status, generatedAt: document.generated_at, downloadUrl: "" };
    const { data } = await db().storage.from("hr-exit-documents").createSignedUrl(document.storage_path, 15 * 60);
    return { id: document.id, type: document.document_type, name: document.file_name, status: document.status, generatedAt: document.generated_at, downloadUrl: data?.signedUrl ?? "" };
  }));
  const reason = Array.isArray(row.hr_exit_reasons) ? row.hr_exit_reasons[0] : row.hr_exit_reasons;
  const assigneeIds = [...new Set((approvals ?? []).map((approval) => approval.assigned_user_id).filter(Boolean))];
  const { data: assignees } = assigneeIds.length
    ? await db().from("profiles").select("id, full_name").eq("company_id", row.company_id).in("id", assigneeIds)
    : { data: [] };
  const assigneeName = new Map((assignees ?? []).map((profile) => [profile.id, profile.full_name]));
  const submittedEvent = (events ?? []).find((event) => event.event_code === "CASE_SUBMITTED");
  const laterEvents = (events ?? []).filter((event) => !["CASE_SUBMITTED", "APPROVAL_COMPLETED"].includes(event.event_code));
  const timeline = [
    ...(submittedEvent ? [{ id: `event-${submittedEvent.id}`, title: submittedEvent.title || "Resignation submitted", status: "completed", createdAt: submittedEvent.created_at, actorName: submittedEvent.actor_name, note: null }] : []),
    ...(approvals ?? []).map((approval) => {
      const roleRelation = Array.isArray(approval.hr_roles) ? approval.hr_roles[0] : approval.hr_roles;
      return {
        id: `approval-${approval.id}`,
        title: approval.step_name,
        status: approval.status,
        createdAt: approval.acted_at || approval.created_at,
        actorName: approval.assigned_user_id ? assigneeName.get(approval.assigned_user_id) ?? "Reporting manager" : roleRelation?.name ?? "Configured People role",
        note: approval.comments
      };
    }),
    ...laterEvents.map((event) => ({ id: `event-${event.id}`, title: event.title || event.event_code.replaceAll("_", " "), status: "completed", createdAt: event.created_at, actorName: event.actor_name, note: typeof event.details?.note === "string" ? event.details.note : null }))
  ];
  return {
    id: row.id,
    caseNumber: row.case_number,
    scenario: row.scenario,
    status: row.status,
    stage: row.current_stage,
    reason: reason?.name ?? "",
    comments: row.employee_reason ?? "",
    requestedLastWorkingDate: row.requested_last_working_date,
    approvedLastWorkingDate: row.approved_last_working_date,
    submittedAt: row.submitted_at,
    settlementStatus: row.settlement_status,
    timeline,
    tasks: tasks ?? [],
    documents: safeDocuments
  };
}

function isTerminalExitStatus(status: string | null | undefined) {
  return ["rejected", "withdrawn", "cancelled", "settled", "closed"].includes(String(status ?? ""));
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const context = await resolveWorker(params.get("profileType") ?? "", params.get("accountId") ?? "");
    const [policyResult, reasonsResult, caseResult] = await Promise.all([
      db().from("hr_exit_policies").select("resignation_notice_days, withdrawal_allowed").eq("company_id", context.account.companyId).maybeSingle(),
      db().from("hr_exit_reasons").select("id, name, comment_required").eq("company_id", context.account.companyId).eq("scenario", "resignation").eq("employee_selectable", true).eq("is_active", true).order("display_order"),
      caseQuery(context).order("submitted_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    if (policyResult.error || reasonsResult.error || caseResult.error) throw new Error(policyResult.error?.message ?? reasonsResult.error?.message ?? caseResult.error?.message ?? "Unable to load exit request.");
    const latestCase = caseResult.data;
    // After a rejected/withdrawn/cancelled case the form is shown again — still resolve the route.
    const canStartNew = !latestCase || isTerminalExitStatus(latestCase.status);
    let approvalRoute: ApprovalRoutePreview[] = [];
    let approvalRouteError = "";
    if (canStartNew) {
      try {
        approvalRoute = (await configuredApprovalRoute(context, "resignation")).preview;
      } catch (problem) {
        approvalRouteError = problem instanceof Error ? problem.message : "The approval route is not ready.";
      }
    }
    return NextResponse.json({
      ok: true,
      flow: "people",
      destination: context.workerType === "contractor" ? "People · Individual contractor exit" : "People · Employee exit",
      policy: policyResult.data ?? { resignation_notice_days: 30, withdrawal_allowed: true },
      reasons: reasonsResult.data ?? [],
      approvalRoute,
      approvalRouteReady: !approvalRouteError && approvalRoute.length > 0,
      approvalRouteError,
      exitCase: latestCase ? await serializeCase(latestCase) : null
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load exit request." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const context = await resolveWorker(clean(body.profileType), clean(body.accountId));
    const action = clean(body.action || "submit");

    if (action === "withdraw") {
      const [policyResult, caseResult] = await Promise.all([
        db().from("hr_exit_policies").select("withdrawal_allowed").eq("company_id", context.account.companyId).maybeSingle(),
        caseQuery(context).not("status", "in", '("closed","rejected","withdrawn","cancelled")').order("submitted_at", { ascending: false }).limit(1).maybeSingle()
      ]);
      if (policyResult.error || caseResult.error) throw new Error(policyResult.error?.message ?? caseResult.error?.message ?? "Unable to load exit request.");
      if (!policyResult.data?.withdrawal_allowed) throw new Error("Withdrawal requests are disabled by company policy.");
      const exitCase = caseResult.data;
      if (!exitCase || ["documents_ready", "closed", "withdrawal_requested"].includes(exitCase.status)) {
        throw new Error(exitCase?.status === "withdrawal_requested"
          ? "A withdrawal request is already waiting for the first approving manager."
          : "This exit request can no longer be withdrawn.");
      }
      const now = new Date().toISOString();
      const approvedSteps = await db().from("hr_exit_approvals")
        .select("id,step_order,step_name,assigned_user_id,acted_by,status")
        .eq("company_id", context.account.companyId)
        .eq("case_id", exitCase.id)
        .eq("is_required", true)
        .eq("status", "approved")
        .order("step_order");
      if (approvedSteps.error) throw new Error(approvedSteps.error.message);
      const firstApproved = (approvedSteps.data ?? [])[0] ?? null;
      const reviewerUserId = firstApproved?.acted_by ?? firstApproved?.assigned_user_id ?? null;

      // Before any required approval: employee may withdraw immediately.
      if (!firstApproved || !reviewerUserId) {
        const updated = await db().from("hr_exit_cases").update({
          status: "withdrawn",
          current_stage: "closed",
          updated_at: now
        }).eq("id", exitCase.id);
        if (updated.error) throw new Error(updated.error.message);
        const skipped = await db().from("hr_exit_approvals").update({ status: "skipped", updated_at: now })
          .eq("case_id", exitCase.id).in("status", ["pending", "waiting"]);
        if (skipped.error && !String(skipped.error.message).toLowerCase().includes("does not exist")) {
          throw new Error(skipped.error.message);
        }
        await db().from("hr_exit_events").insert({
          company_id: context.account.companyId,
          case_id: exitCase.id,
          event_code: "WITHDRAWN",
          title: "Resignation withdrawn",
          actor_name: context.account.name ?? context.worker.full_name,
          details: {}
        });
        return NextResponse.json({ ok: true, notice: "Resignation withdrawn. You can submit a new request when ready." });
      }

      // After first-level approval: route withdrawal only to that first approver.
      const requested = await db().from("hr_exit_cases").update({
        status: "withdrawal_requested",
        status_before_withdrawal: exitCase.status,
        withdrawal_reviewer_user_id: reviewerUserId,
        withdrawal_requested_at: now,
        updated_at: now
      }).eq("id", exitCase.id).neq("status", "withdrawal_requested");
      if (requested.error) {
        if (/withdrawal_reviewer_user_id|status_before_withdrawal|schema cache|does not exist/i.test(requested.error.message)) {
          const fallback = await db().from("hr_exit_cases").update({
            status: "withdrawal_requested",
            updated_at: now
          }).eq("id", exitCase.id);
          if (fallback.error) throw new Error(fallback.error.message);
        } else {
          throw new Error(requested.error.message);
        }
      }
      await db().from("hr_exit_events").insert({
        company_id: context.account.companyId,
        case_id: exitCase.id,
        event_code: "WITHDRAWAL_REQUESTED",
        title: "Withdrawal requested — waiting for first approver",
        actor_name: context.account.name ?? context.worker.full_name,
        details: { reviewer_user_id: reviewerUserId, first_step: firstApproved.step_name }
      });
      await notifyEmployeeExitWithdrawal({
        companyId: context.account.companyId,
        caseId: exitCase.id,
        employee: context.worker,
        requestedDate: exitCase.requested_last_working_date ?? ""
      });
      const reviewer = await db().from("profiles").select("email,full_name").eq("company_id", context.account.companyId).eq("id", reviewerUserId).maybeSingle();
      await notifyExitWithdrawalReviewer({
        companyId: context.account.companyId,
        caseId: exitCase.id,
        reviewerUserId,
        employeeName: context.worker.full_name,
        caseNumber: exitCase.case_number,
        requestedDate: exitCase.requested_last_working_date ?? ""
      }).catch(() => undefined);
      return NextResponse.json({
        ok: true,
        notice: `Withdrawal requested. Only ${reviewer.data?.full_name ?? "the first approving manager"} can accept it. Your request stays open until they decide.`
      });
    }

    const reasonId = clean(body.reasonId);
    const comments = clean(body.comments);
    const requestedDate = clean(body.requestedLastWorkingDate);
    const personalEmail = clean(body.personalEmail) || context.account.email || context.worker.email;
    const personalMobile = clean(body.personalMobile) || context.worker.mobile;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) throw new Error("Select a requested last working date.");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const date = new Date(`${requestedDate}T00:00:00`);
    const max = new Date(today);
    max.setFullYear(max.getFullYear() + 1);
    if (date < today || date > max) throw new Error("Requested last working date must be between today and one year from today.");

    const [reasonResult, policyResult, existingResult] = await Promise.all([
      db().from("hr_exit_reasons").select("id, name, comment_required, default_rehire_eligible").eq("company_id", context.account.companyId).eq("scenario", "resignation").eq("employee_selectable", true).eq("is_active", true).eq("id", reasonId).maybeSingle(),
      db().from("hr_exit_policies").select("*").eq("company_id", context.account.companyId).maybeSingle(),
      caseQuery(context).not("status", "in", '("closed","rejected","withdrawn","cancelled","withdrawal_requested")').limit(1)
    ]);
    if (reasonResult.error || policyResult.error || existingResult.error) throw new Error(reasonResult.error?.message ?? policyResult.error?.message ?? existingResult.error?.message ?? "Unable to validate exit request.");
    if (!context.worker.is_active || !reasonResult.data) throw new Error("Profile or resignation reason is unavailable.");
    if (reasonResult.data.comment_required && comments.length < 3) throw new Error("Comments are required for this resignation reason.");
    if (existingResult.data?.length) throw new Error("An active exit request already exists.");

    const approvalRoute = await configuredApprovalRoute(context, "resignation");
    const approvalRows = approvalRoute.rows;

    const { data: caseNumber, error: numberError } = await db().rpc("hr_next_exit_case_number", { p_company_id: context.account.companyId, p_prefix: policyResult.data?.case_number_prefix ?? "EXIT" });
    if (numberError) throw new Error(numberError.message);
    const managerId = approvalRoute.firstManagerId;
    const insert = {
      company_id: context.account.companyId,
      case_number: caseNumber,
      employee_id: context.workerType === "employee" ? context.workerId : null,
      contractor_id: context.workerType === "contractor" ? context.workerId : null,
      worker_type: context.workerType,
      source: "employee",
      scenario: "resignation",
      reason_id: reasonResult.data.id,
      employee_reason: comments || null,
      requested_last_working_date: requestedDate,
      notice_days: policyResult.data?.resignation_notice_days ?? 30,
      status: "submitted",
      current_stage: "review",
      manager_user_id: managerId,
      personal_email: personalEmail || null,
      personal_mobile: personalMobile || null,
      rehire_eligible: reasonResult.data.default_rehire_eligible
    };
    const { data: exitCase, error: insertError } = await db().from("hr_exit_cases").insert(insert).select("id").single();
    if (insertError) throw new Error(insertError.message);

    if (approvalRows.length) {
      const inserted = await db().from("hr_exit_approvals").insert(approvalRows.map((step) => ({ ...step, case_id: exitCase.id })));
      if (inserted.error) throw new Error(inserted.error.message);
    }
    if (policyResult.data?.auto_create_tasks !== false) {
      const { data: templates } = await db().from("hr_exit_task_templates").select("*").eq("company_id", context.account.companyId).eq("is_active", true).in("scenario", ["resignation", "all"]).order("display_order");
      if (templates?.length) {
        const rows = await Promise.all(templates.map(async (template) => {
          const due = new Date(`${requestedDate}T00:00:00Z`);
          due.setUTCDate(due.getUTCDate() + template.due_offset_days);
          return { company_id: context.account.companyId, case_id: exitCase.id, template_id: template.id, category: template.category, code: template.code, name: template.name, instructions: template.instructions, owner_role: template.owner_role, owner_user_id: template.owner_role === "EMPLOYEE" ? null : await taskOwnerUser(context, template.owner_role), due_date: due.toISOString().slice(0, 10), is_required: template.is_required };
        }));
        const inserted = await db().from("hr_exit_tasks").insert(rows);
        if (inserted.error) throw new Error(inserted.error.message);
      }
    }
    await db().from("hr_exit_events").insert({ company_id: context.account.companyId, case_id: exitCase.id, event_code: "CASE_SUBMITTED", title: "Resignation submitted", actor_name: context.account.name ?? context.worker.full_name, details: { requested_last_working_date: requestedDate } });
    await notifyEmployeeExitSubmitted({ companyId: context.account.companyId, caseId: exitCase.id, employee: context.worker, requestedDate });
    await createAppNotification({
      accountId: context.workerId,
      companyId: context.account.companyId,
      eventCode: "exit_request_raised",
      profileType: context.workerType,
      sourceKey: String(exitCase.id)
    });
    const firstApproval = approvalRows.slice().sort((left, right) => left.step_order - right.step_order)[0];
    if (firstApproval) await notifyExitApprovalRequired({ companyId: context.account.companyId, caseId: exitCase.id, approvalStepId: firstApproval.workflow_step_id });
    return NextResponse.json({ ok: true, notice: `Resignation submitted successfully. Case ${caseNumber} has been sent for review.` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit exit request." }, { status: 400 });
  }
}

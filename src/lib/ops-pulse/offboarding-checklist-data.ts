import "server-only";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * Terminal hr_exit_cases.status values, matching the set already used cross-repo
 * in src/app/api/biometric/punch/route.ts (isWithinConfirmedLastWorkingDay) -
 * kept identical here so "currently offboarding" means the same thing everywhere
 * this database is read from.
 */
const TERMINAL_EXIT_STATUSES = new Set(["closed", "rejected", "withdrawn", "cancelled"]);

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export type OffboardingApprovalGate = {
  approvalId: string;
  approvalLevelId: string;
  levelCode: string;
  levelName: string;
  approverRole: string;
  sequenceOrder: number;
  status: "pending" | "approved" | "rejected" | "skipped";
  approverUserId: string | null;
  proofNote: string | null;
  actedBy: string | null;
  actedAt: string | null;
  /** True when the current viewer holds this level for this specific task, today. */
  viewerCanAct: boolean;
  /** True when every lower-sequence_order gate on this task is already approved. */
  unlockedByPriorLevels: boolean;
};

export type OffboardingTask = {
  taskId: string;
  templateId: string | null;
  category: string;
  code: string;
  name: string;
  instructions: string | null;
  ownerRole: string;
  dueDate: string | null;
  isRequired: boolean;
  status: "pending" | "in_progress" | "completed" | "waived" | "blocked";
  completionNote: string | null;
  mandatoryProof: string | null;
  approvals: OffboardingApprovalGate[];
};

export type OffboardingCase = {
  caseId: string;
  caseNumber: string;
  scenario: string;
  status: string;
  workerType: "employee" | "contractor";
  workerId: string;
  personId: string | null;
  displayName: string;
  designationName: string | null;
  requestedLastWorkingDate: string | null;
  approvedLastWorkingDate: string | null;
  tasks: OffboardingTask[];
};

export type OffboardingChecklistWorkspace = {
  checkedAt: string;
  cases: OffboardingCase[];
};

type DirectReport = {
  personId: string;
  assignmentId: string;
  displayName: string;
  designationName: string | null;
  workerType: "employee" | "contractor";
  workerId: string;
};

/**
 * Direct reports of the logged-in manager, resolved the same way
 * people-operational-hierarchy.ts resolves the org graph (hr_work_assignments,
 * hr_engagements, hr_people, hr_reporting_relationships) - no existing helper
 * in this repo already exposes "who reports directly to user X", so this
 * mirrors that module's query/shape conventions instead of introducing a new
 * cross-cutting hierarchy abstraction.
 */
async function loadDirectReports(companyId: string, managerUserId: string): Promise<{ reports: DirectReport[]; managerAssignmentIds: string[]; error: string | null }> {
  const empty = { reports: [] as DirectReport[], managerAssignmentIds: [] as string[], error: null as string | null };
  if (!supabaseAdmin) return { ...empty, error: "Supabase service role key is not configured." };

  const linkResult = await supabaseAdmin
    .from("hr_user_person_links")
    .select("person_id")
    .eq("company_id", companyId)
    .eq("user_id", managerUserId)
    .eq("status", "active");
  if (linkResult.error) return { ...empty, error: linkResult.error.message };
  const managerPersonIds = [...new Set((linkResult.data ?? []).map((row) => row.person_id).filter(Boolean))];
  if (!managerPersonIds.length) return empty;

  const day = indiaToday();
  const managerEngagementsResult = await supabaseAdmin
    .from("hr_engagements")
    .select("id,person_id,status")
    .eq("company_id", companyId)
    .eq("status", "active")
    .in("person_id", managerPersonIds);
  if (managerEngagementsResult.error) return { ...empty, error: managerEngagementsResult.error.message };
  const managerEngagementIds = (managerEngagementsResult.data ?? []).map((row) => row.id);
  if (!managerEngagementIds.length) return empty;

  const managerAssignmentsResult = await supabaseAdmin
    .from("hr_work_assignments")
    .select("id,engagement_id")
    .eq("company_id", companyId)
    .eq("is_primary", true)
    .in("engagement_id", managerEngagementIds)
    .lte("effective_from", day)
    .or(`effective_to.is.null,effective_to.gte.${day}`);
  if (managerAssignmentsResult.error) return { ...empty, error: managerAssignmentsResult.error.message };
  const managerAssignmentIds = [...new Set((managerAssignmentsResult.data ?? []).map((row) => row.id))];
  if (!managerAssignmentIds.length) return empty;

  const relationshipsResult = await supabaseAdmin
    .from("hr_reporting_relationships")
    .select("subject_assignment_id,manager_assignment_id")
    .eq("company_id", companyId)
    .eq("relationship_type", "solid_line")
    .eq("is_primary", true)
    .in("manager_assignment_id", managerAssignmentIds)
    .lte("effective_from", day)
    .or(`effective_to.is.null,effective_to.gte.${day}`);
  if (relationshipsResult.error) return { ...empty, error: relationshipsResult.error.message };
  const subjectAssignmentIds = [...new Set((relationshipsResult.data ?? []).map((row) => row.subject_assignment_id).filter(Boolean))];
  if (!subjectAssignmentIds.length) return { reports: [], managerAssignmentIds, error: null };

  const subjectAssignmentsResult = await supabaseAdmin
    .from("hr_work_assignments")
    .select("id,engagement_id,designation_id")
    .eq("company_id", companyId)
    .in("id", subjectAssignmentIds);
  if (subjectAssignmentsResult.error) return { ...empty, error: subjectAssignmentsResult.error.message };
  const subjectAssignments = subjectAssignmentsResult.data ?? [];
  const subjectEngagementIds = [...new Set(subjectAssignments.map((row) => row.engagement_id))];
  if (!subjectEngagementIds.length) return { reports: [], managerAssignmentIds, error: null };

  const [subjectEngagementsResult, designationsResult] = await Promise.all([
    supabaseAdmin
      .from("hr_engagements")
      .select("id,person_id,worker_type,employee_id,contractor_id,status")
      .eq("company_id", companyId)
      .eq("status", "active")
      .in("id", subjectEngagementIds),
    supabaseAdmin
      .from("designations")
      .select("id,name")
      .eq("company_id", companyId)
  ]);
  if (subjectEngagementsResult.error) return { ...empty, error: subjectEngagementsResult.error.message };
  if (designationsResult.error) return { ...empty, error: designationsResult.error.message };
  const designationById = new Map((designationsResult.data ?? []).map((row) => [row.id, row.name as string | null]));
  const engagementById = new Map((subjectEngagementsResult.data ?? []).map((row) => [row.id, row]));

  const personIds = [...new Set((subjectEngagementsResult.data ?? []).map((row) => row.person_id).filter(Boolean))];
  const peopleResult = personIds.length
    ? await supabaseAdmin.from("hr_people").select("id,display_name").eq("company_id", companyId).in("id", personIds)
    : { data: [], error: null };
  if (peopleResult.error) return { ...empty, error: peopleResult.error.message };
  const nameByPersonId = new Map((peopleResult.data ?? []).map((row) => [row.id, row.display_name as string]));

  const reports: DirectReport[] = subjectAssignments.flatMap((assignment) => {
    const engagement = engagementById.get(assignment.engagement_id);
    if (!engagement) return [];
    const workerType = engagement.worker_type === "contractor" ? "contractor" as const : "employee" as const;
    const workerId = workerType === "contractor" ? engagement.contractor_id : engagement.employee_id;
    if (!workerId || !engagement.person_id) return [];
    return [{
      personId: engagement.person_id,
      assignmentId: assignment.id,
      displayName: nameByPersonId.get(engagement.person_id) ?? "Unknown",
      designationName: assignment.designation_id ? designationById.get(assignment.designation_id) ?? null : null,
      workerType,
      workerId
    }];
  });

  return { reports, managerAssignmentIds, error: null };
}

/**
 * Which approval level(s) the current manager holds for a given worker's exit
 * task approvals. REPORTING_MANAGER levels are resolved by manager-chain depth
 * (lowest sequence_order REPORTING_MANAGER level = the worker's direct manager,
 * the next REPORTING_MANAGER level = that manager's manager, etc.) using the
 * same hr_reporting_relationships walk as
 * dropx-hrms/src/lib/exit-case-instantiation.ts's reportingManagerUserAtLevel.
 * HR-tier levels (HR_MANAGER and any other non-REPORTING_MANAGER role) are
 * treated as held by anyone with edit access on this Ops permission - see
 * hasHrTierAccess below; this is a deliberate first-version simplification
 * flagged in the task report rather than modeling HRMS's own role/permission
 * matrix (hr_roles / usersWithHrmsPermission) inside the Ops repo.
 */
async function reportingManagerAssignmentChain(companyId: string, subjectAssignmentId: string): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const day = indiaToday();
  const chain: string[] = [];
  const seen = new Set<string>([subjectAssignmentId]);
  let currentId = subjectAssignmentId;
  for (let depth = 0; depth < 8; depth += 1) {
    const relationship = await supabaseAdmin
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

function hasHrTierAccess(auth: AuthorizationContext) {
  return hasPermission(auth, "ops_offboarding_checklist", "edit");
}

type RawTemplate = { id: string; mandatory_proof: string | null };
type RawLevel = { id: string; code: string; name: string; approver_role: string; sequence_order: number };
type RawApproval = {
  id: string;
  task_id: string;
  approval_level_id: string;
  sequence_order: number;
  status: "pending" | "approved" | "rejected" | "skipped";
  approver_user_id: string | null;
  proof_note: string | null;
  acted_by: string | null;
  acted_at: string | null;
};
type RawTask = {
  id: string;
  case_id: string;
  template_id: string | null;
  category: string;
  code: string;
  name: string;
  instructions: string | null;
  owner_role: string;
  due_date: string | null;
  is_required: boolean;
  status: "pending" | "in_progress" | "completed" | "waived" | "blocked";
  completion_note: string | null;
};
type RawCase = {
  id: string;
  case_number: string;
  scenario: string;
  status: string;
  worker_type: "employee" | "contractor";
  employee_id: string | null;
  contractor_id: string | null;
  manager_user_id: string | null;
  requested_last_working_date: string | null;
  approved_last_working_date: string | null;
};

/**
 * Loads the logged-in manager's direct reports who are currently offboarding,
 * each with their full HRMS-configured exit checklist and, per approval gate,
 * whether the current viewer can act on it right now (level held + sequential
 * gate already cleared). Mirrors unplanned-leaves-data.ts's conventions:
 * hasPermission guard, requireCompanyId, supabaseAdmin reads, thrown Errors
 * with user-facing messages.
 */
export async function loadOffboardingChecklist(auth: AuthorizationContext): Promise<OffboardingChecklistWorkspace> {
  if (!hasPermission(auth, "ops_offboarding_checklist", "access")) throw new Error("Offboarding checklist access is required.");
  if (!supabaseAdmin) throw new Error("Offboarding checklist service unavailable.");
  const companyId = requireCompanyId(auth);

  const { reports, error: reportsError } = await loadDirectReports(companyId, auth.userId);
  if (reportsError) throw new Error("Your reporting team could not be resolved. Please contact HR.");
  const checkedAt = new Date().toISOString();
  if (!reports.length) return { checkedAt, cases: [] };

  const employeeIds = reports.filter((r) => r.workerType === "employee").map((r) => r.workerId);
  const contractorIds = reports.filter((r) => r.workerType === "contractor").map((r) => r.workerId);

  const casesResult = await supabaseAdmin
    .from("hr_exit_cases")
    .select("id,case_number,scenario,status,worker_type,employee_id,contractor_id,manager_user_id,requested_last_working_date,approved_last_working_date")
    .eq("company_id", companyId)
    .or([
      employeeIds.length ? `and(worker_type.eq.employee,employee_id.in.(${employeeIds.join(",")}))` : "",
      contractorIds.length ? `and(worker_type.eq.contractor,contractor_id.in.(${contractorIds.join(",")}))` : ""
    ].filter(Boolean).join(","));
  if (casesResult.error) throw new Error("Offboarding cases could not be loaded.");
  const openCases = ((casesResult.data ?? []) as RawCase[]).filter((row) => !TERMINAL_EXIT_STATUSES.has(row.status));
  if (!openCases.length) return { checkedAt, cases: [] };

  const reportByWorker = new Map(reports.map((r) => [`${r.workerType}:${r.workerId}`, r]));

  const caseIds = openCases.map((row) => row.id);
  const tasksResult = await supabaseAdmin
    .from("hr_exit_tasks")
    .select("id,case_id,template_id,category,code,name,instructions,owner_role,due_date,is_required,status,completion_note")
    .in("case_id", caseIds)
    .eq("company_id", companyId);
  if (tasksResult.error) throw new Error("Offboarding checklist tasks could not be loaded.");
  const tasks = (tasksResult.data ?? []) as RawTask[];
  const taskIds = tasks.map((row) => row.id);
  const templateIds = [...new Set(tasks.map((row) => row.template_id).filter((id): id is string => Boolean(id)))];

  const [approvalsResult, templatesResult, levelsResult] = await Promise.all([
    taskIds.length
      ? supabaseAdmin.from("hr_exit_task_approvals")
          .select("id,task_id,approval_level_id,sequence_order,status,approver_user_id,proof_note,acted_by,acted_at")
          .eq("company_id", companyId)
          .in("task_id", taskIds)
          .order("sequence_order", { ascending: true })
      : Promise.resolve({ data: [] as RawApproval[], error: null }),
    templateIds.length
      ? supabaseAdmin.from("hr_exit_task_templates").select("id,mandatory_proof").eq("company_id", companyId).in("id", templateIds)
      : Promise.resolve({ data: [] as RawTemplate[], error: null }),
    supabaseAdmin.from("hr_exit_task_approval_levels").select("id,code,name,approver_role,sequence_order").eq("company_id", companyId)
  ]);
  if (approvalsResult.error) throw new Error("Offboarding approval gates could not be loaded.");
  if (templatesResult.error) throw new Error("Offboarding task templates could not be loaded.");
  if (levelsResult.error) throw new Error("Offboarding approval levels could not be loaded.");

  const approvals = (approvalsResult.data ?? []) as RawApproval[];
  const templateById = new Map(((templatesResult.data ?? []) as RawTemplate[]).map((row) => [row.id, row]));
  const levelById = new Map(((levelsResult.data ?? []) as RawLevel[]).map((row) => [row.id, row]));

  const approvalsByTask = new Map<string, RawApproval[]>();
  approvals.forEach((row) => {
    const list = approvalsByTask.get(row.task_id) ?? [];
    list.push(row);
    approvalsByTask.set(row.task_id, list);
  });

  const managerChainCache = new Map<string, string[]>();
  const hrTierEligible = hasHrTierAccess(auth);

  async function managerChainFor(assignmentId: string) {
    if (!managerChainCache.has(assignmentId)) {
      managerChainCache.set(assignmentId, await reportingManagerAssignmentChain(companyId, assignmentId));
    }
    return managerChainCache.get(assignmentId)!;
  }

  // The current user's own assignment ids (from loadDirectReports) let us tell
  // whether a given manager-chain assignment id belongs to the viewer.
  const viewerLinkResult = await supabaseAdmin
    .from("hr_user_person_links")
    .select("person_id")
    .eq("company_id", companyId)
    .eq("user_id", auth.userId)
    .eq("status", "active");
  const viewerPersonIds = new Set((viewerLinkResult.data ?? []).map((row) => row.person_id));
  const day = indiaToday();
  const viewerEngagementsResult = viewerPersonIds.size
    ? await supabaseAdmin.from("hr_engagements").select("id").eq("company_id", companyId).eq("status", "active").in("person_id", [...viewerPersonIds])
    : { data: [] as { id: string }[] };
  const viewerEngagementIds = (viewerEngagementsResult.data ?? []).map((row) => row.id);
  const viewerAssignmentsResult = viewerEngagementIds.length
    ? await supabaseAdmin.from("hr_work_assignments").select("id").eq("company_id", companyId).eq("is_primary", true)
        .in("engagement_id", viewerEngagementIds).lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`)
    : { data: [] as { id: string }[] };
  const viewerAssignmentIds = new Set((viewerAssignmentsResult.data ?? []).map((row) => row.id));

  const resultCases: OffboardingCase[] = [];
  for (const caseRow of openCases) {
    const workerId = caseRow.worker_type === "contractor" ? caseRow.contractor_id : caseRow.employee_id;
    const report = workerId ? reportByWorker.get(`${caseRow.worker_type}:${workerId}`) : undefined;
    if (!report) continue;

    const caseTasks = tasks.filter((row) => row.case_id === caseRow.id);
    const managerChain = await managerChainFor(report.assignmentId);

    const resultTasks: OffboardingTask[] = caseTasks.map((task) => {
      const gates = (approvalsByTask.get(task.id) ?? []).sort((a, b) => a.sequence_order - b.sequence_order);
      const template = task.template_id ? templateById.get(task.template_id) : undefined;
      const approvalGates: OffboardingApprovalGate[] = gates.map((gate, index) => {
        const level = levelById.get(gate.approval_level_id);
        const priorLevelsApproved = gates.slice(0, index).every((prior) => prior.status === "approved");
        let viewerCanAct = false;
        if (gate.status === "pending" && level) {
          if (level.approver_role === "REPORTING_MANAGER") {
            // Sort the REPORTING_MANAGER levels for this task by sequence_order to
            // map "1st REPORTING_MANAGER level" -> manager-chain depth 0, etc.
            const reportingManagerLevelsInOrder = gates
              .map((g) => levelById.get(g.approval_level_id))
              .filter((lvl): lvl is RawLevel => Boolean(lvl) && lvl!.approver_role === "REPORTING_MANAGER")
              .sort((a, b) => a.sequence_order - b.sequence_order);
            const depth = reportingManagerLevelsInOrder.findIndex((lvl) => lvl.id === level.id);
            const requiredAssignmentId = depth >= 0 ? managerChain[depth] : undefined;
            viewerCanAct = Boolean(requiredAssignmentId && viewerAssignmentIds.has(requiredAssignmentId));
          } else {
            // HR_MANAGER / other non-manager-chain roles: first-version simplification,
            // see hasHrTierAccess doc comment above.
            viewerCanAct = hrTierEligible;
          }
        }
        return {
          approvalId: gate.id,
          approvalLevelId: gate.approval_level_id,
          levelCode: level?.code ?? "UNKNOWN",
          levelName: level?.name ?? "Unknown level",
          approverRole: level?.approver_role ?? "",
          sequenceOrder: gate.sequence_order,
          status: gate.status,
          approverUserId: gate.approver_user_id,
          proofNote: gate.proof_note,
          actedBy: gate.acted_by,
          actedAt: gate.acted_at,
          viewerCanAct: viewerCanAct && priorLevelsApproved,
          unlockedByPriorLevels: priorLevelsApproved
        };
      });

      return {
        taskId: task.id,
        templateId: task.template_id,
        category: task.category,
        code: task.code,
        name: task.name,
        instructions: task.instructions,
        ownerRole: task.owner_role,
        dueDate: task.due_date,
        isRequired: task.is_required,
        status: task.status,
        completionNote: task.completion_note,
        mandatoryProof: template?.mandatory_proof ?? null,
        approvals: approvalGates
      };
    });

    resultCases.push({
      caseId: caseRow.id,
      caseNumber: caseRow.case_number,
      scenario: caseRow.scenario,
      status: caseRow.status,
      workerType: caseRow.worker_type,
      workerId: workerId!,
      personId: report.personId,
      displayName: report.displayName,
      designationName: report.designationName,
      requestedLastWorkingDate: caseRow.requested_last_working_date,
      approvedLastWorkingDate: caseRow.approved_last_working_date,
      tasks: resultTasks
    });
  }

  return { checkedAt, cases: resultCases };
}

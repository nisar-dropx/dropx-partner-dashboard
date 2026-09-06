import "server-only";

import { resolveConfiguredApprovalWorkflow } from "./configured-approval-routing";
import { supabaseAdmin } from "./supabase-admin";
import type { ConnectAccount } from "./connect-auth";

export type ExpenseWorkerType = "employee" | "contractor";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function expenseWorkerType(profileType: string): ExpenseWorkerType | null {
  return profileType === "employee" || profileType === "contractor" ? profileType : null;
}

export async function expenseIdentity(account: ConnectAccount) {
  const workerType = expenseWorkerType(account.profileType);
  if (!workerType) throw new Error("Reimbursements are available for employees and independent contractors.");
  const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
  const today = indiaToday();
  const engagement = await db().from("hr_engagements").select("id,person_id,status")
    .eq("company_id", account.companyId).eq("worker_type", workerType).eq(workerColumn, account.id).maybeSingle();
  if (engagement.error || !engagement.data || engagement.data.status !== "active") {
    throw new Error(engagement.error?.message ?? "Your active People engagement is not configured.");
  }
  const assignment = await db().from("hr_work_assignments")
    .select("id,business_line,position_title,location_id,designation_id,is_top_level,effective_from,effective_to")
    .eq("company_id", account.companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error || !assignment.data) throw new Error(assignment.error?.message ?? "Your active work assignment is not configured.");
  const link = await db().from("hr_user_person_links").select("user_id,status")
    .eq("company_id", account.companyId).eq("person_id", engagement.data.person_id).maybeSingle();
  if (link.error) throw new Error(link.error.message);
  return {
    workerType,
    workerId: account.id,
    personId: engagement.data.person_id,
    userId: link.data?.status === "active" ? link.data.user_id : null,
    assignment: assignment.data,
    today
  };
}

export async function connectApproverIdentity(account: ConnectAccount) {
  if (account.profileType !== "user") return expenseIdentity(account);
  const today = indiaToday();
  const link = await db().from("hr_user_person_links").select("person_id,status")
    .eq("company_id", account.companyId).eq("user_id", account.id).eq("status", "active")
    .limit(1).maybeSingle();
  if (link.error || !link.data) {
    throw new Error(link.error?.message ?? "Your People login is not linked to an active person record.");
  }
  const engagement = await db().from("hr_engagements").select("id,person_id,worker_type,employee_id,contractor_id,status")
    .eq("company_id", account.companyId).eq("person_id", link.data.person_id).eq("status", "active")
    .limit(1).maybeSingle();
  if (engagement.error || !engagement.data) {
    throw new Error(engagement.error?.message ?? "Your active People engagement is not configured.");
  }
  const assignment = await db().from("hr_work_assignments")
    .select("id,business_line,position_title,location_id,designation_id,is_top_level,effective_from,effective_to")
    .eq("company_id", account.companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error || !assignment.data) {
    throw new Error(assignment.error?.message ?? "Your current People assignment is not configured.");
  }
  const workerType: ExpenseWorkerType = engagement.data.worker_type === "contractor" ? "contractor" : "employee";
  return {
    workerType,
    workerId: engagement.data.employee_id ?? engagement.data.contractor_id ?? account.id,
    personId: engagement.data.person_id,
    userId: account.id,
    assignment: assignment.data,
    today
  };
}

export async function resolveExpensePolicy(account: ConnectAccount, amount: number) {
  const identity = await expenseIdentity(account);
  const result = await db().from("hr_expense_policies")
    .select("id,name,worker_type,location_id,designation_id,minimum_amount,maximum_amount,manager_levels,allow_short_manager_chain,fallback_approver_role_ids,payment_head_id,priority,effective_from,effective_to")
    .eq("company_id", account.companyId).eq("is_active", true).lte("minimum_amount", amount)
    .lte("effective_from", identity.today).or(`effective_to.is.null,effective_to.gte.${identity.today}`)
    .order("priority");
  if (result.error) throw new Error(result.error.message);
  const policy = (result.data ?? []).filter((item) =>
    (item.worker_type === "all" || item.worker_type === identity.workerType) &&
    (!item.location_id || item.location_id === identity.assignment.location_id) &&
    (!item.designation_id || item.designation_id === identity.assignment.designation_id) &&
    (item.maximum_amount == null || Number(item.maximum_amount) >= amount)
  ).sort((left, right) => {
    const specificity = (item: typeof left) => (item.location_id ? 2 : 0) + (item.designation_id ? 1 : 0) + (item.worker_type === "all" ? 0 : 1);
    return specificity(right) - specificity(left) || left.priority - right.priority;
  })[0];
  if (!policy?.payment_head_id) throw new Error("No active reimbursement policy and payment head match this claim.");
  return { identity, policy };
}

export async function resolveExpenseApprovers(account: ConnectAccount, amount: number) {
  const { identity, policy } = await resolveExpensePolicy(account, amount);
  const configured = await resolveConfiguredApprovalWorkflow({
    companyId: account.companyId,
    workflowCode: "reimbursement",
    workerId: identity.workerId,
    workerType: identity.workerType,
    asOf: identity.today
  });
  if (configured) {
    return {
      identity,
      policy,
      steps: configured.steps.map((step, index) => ({
        step_order: index + 1,
        step_name: step.step_name,
        approver_user_id: step.approver_user_id,
        approver_person_id: step.approver_person_id
      }))
    };
  }
  const steps: Array<{ step_order: number; step_name: string; approver_user_id: string; approver_person_id: string }> = [];
  const seen = new Set<string>([identity.personId]);
  let subjectAssignmentId = identity.assignment.id;
  for (let level = 1; level <= policy.manager_levels; level += 1) {
    const relationship = await db().from("hr_reporting_relationships").select("manager_assignment_id")
      .eq("company_id", account.companyId).eq("subject_assignment_id", subjectAssignmentId)
      .eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", identity.today).or(`effective_to.is.null,effective_to.gte.${identity.today}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (relationship.error) throw new Error(relationship.error.message);
    if (!relationship.data) {
      if (policy.allow_short_manager_chain && steps.length > 0) break;
      throw new Error(`Reporting manager level ${level} is not configured for this reimbursement policy.`);
    }
    const assignment = await db().from("hr_work_assignments").select("id,engagement_id,position_title")
      .eq("company_id", account.companyId).eq("id", relationship.data.manager_assignment_id).maybeSingle();
    if (assignment.error || !assignment.data) throw new Error(`Reporting manager level ${level} is not active.`);
    const engagement = await db().from("hr_engagements").select("person_id,status")
      .eq("company_id", account.companyId).eq("id", assignment.data.engagement_id).maybeSingle();
    if (engagement.error || !engagement.data || engagement.data.status !== "active") throw new Error(`Reporting manager level ${level} is not active.`);
    if (seen.has(engagement.data.person_id)) throw new Error("The reporting hierarchy contains a cycle.");
    seen.add(engagement.data.person_id);
    const link = await db().from("hr_user_person_links").select("user_id,status")
      .eq("company_id", account.companyId).eq("person_id", engagement.data.person_id).maybeSingle();
    if (link.error || !link.data || link.data.status !== "active") throw new Error(`${assignment.data.position_title} does not have an active One/People login.`);
    steps.push({ step_order: level, step_name: `${assignment.data.position_title} approval`, approver_user_id: link.data.user_id, approver_person_id: engagement.data.person_id });
    subjectAssignmentId = assignment.data.id;
  }
  if (!steps.length) throw new Error("No reporting manager is configured. Configure a reporting line or policy fallback before submission.");
  return { identity, policy, steps };
}

export async function activeExpenseCategories(account: ConnectAccount) {
  const result = await db().from("hr_expense_categories")
    .select("id,code,name,description,receipt_required,receipt_threshold,per_item_limit,per_day_limit,sort_order")
    .eq("company_id", account.companyId).eq("is_active", true).order("sort_order").order("name");
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

export async function expenseCategoriesForPolicy(account: ConnectAccount, policyId: string) {
  const [categories, rules] = await Promise.all([
    activeExpenseCategories(account),
    db().from("hr_expense_policy_categories")
      .select("category_id,is_allowed,receipt_required_override,receipt_threshold_override,per_item_limit_override,per_day_limit_override")
      .eq("company_id", account.companyId).eq("policy_id", policyId)
  ]);
  if (rules.error) throw new Error(rules.error.message);
  const byCategory = new Map((rules.data ?? []).map((rule) => [rule.category_id, rule]));
  return categories.flatMap((category) => {
    const rule = byCategory.get(category.id);
    if (rule && !rule.is_allowed) return [];
    return [{
      ...category,
      receipt_required: rule?.receipt_required_override ?? category.receipt_required,
      receipt_threshold: rule?.receipt_threshold_override ?? category.receipt_threshold,
      per_item_limit: rule?.per_item_limit_override ?? category.per_item_limit,
      per_day_limit: rule?.per_day_limit_override ?? category.per_day_limit
    }];
  });
}

export async function expensePayoutReadiness(account: ConnectAccount) {
  const table = account.profileType === "employee" ? "employees" : "contractors";
  const ifscColumn = account.profileType === "employee" ? "ifsc" : "ifsc_code";
  const result = await db().from(table).select(`bank_account_no,${ifscColumn}`).eq("company_id", account.companyId).eq("id", account.id).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as Record<string, unknown> | null;
  const ready = Boolean(String(row?.bank_account_no ?? "").trim() && String(row?.[ifscColumn] ?? "").trim());
  return { ready, message: ready ? null : "Complete your bank account and IFSC in My Profile before submitting a reimbursement." };
}

export type ExpenseClaimRequestAssignee = {
  assignee_role: "reporting_manager" | "finance_head";
  approver_user_id: string;
  approver_person_id: string | null;
};

async function resolveImmediateReportingManager(account: ConnectAccount, identity: Awaited<ReturnType<typeof expenseIdentity>>): Promise<ExpenseClaimRequestAssignee | null> {
  const relationship = await db().from("hr_reporting_relationships").select("manager_assignment_id")
    .eq("company_id", account.companyId).eq("subject_assignment_id", identity.assignment.id)
    .eq("relationship_type", "solid_line").eq("is_primary", true)
    .lte("effective_from", identity.today).or(`effective_to.is.null,effective_to.gte.${identity.today}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (relationship.error) throw new Error(relationship.error.message);
  if (!relationship.data) return null;
  const assignment = await db().from("hr_work_assignments").select("id,engagement_id,position_title")
    .eq("company_id", account.companyId).eq("id", relationship.data.manager_assignment_id).maybeSingle();
  if (assignment.error || !assignment.data) return null;
  const engagement = await db().from("hr_engagements").select("person_id,status")
    .eq("company_id", account.companyId).eq("id", assignment.data.engagement_id).maybeSingle();
  if (engagement.error || !engagement.data || engagement.data.status !== "active") return null;
  if (engagement.data.person_id === identity.personId) return null;
  const link = await db().from("hr_user_person_links").select("user_id,status")
    .eq("company_id", account.companyId).eq("person_id", engagement.data.person_id).maybeSingle();
  if (link.error || !link.data || link.data.status !== "active") {
    throw new Error(`${assignment.data.position_title} does not have an active One/People login.`);
  }
  return {
    assignee_role: "reporting_manager",
    approver_user_id: link.data.user_id,
    approver_person_id: engagement.data.person_id
  };
}

async function resolveFinanceHeadAssignee(account: ConnectAccount, excludeUserIds: Set<string>): Promise<ExpenseClaimRequestAssignee | null> {
  const head = await db().from("payment_heads")
    .select("payment_process_role_ids")
    .eq("company_id", account.companyId)
    .eq("code", "EMPLOYEE_REIMBURSEMENT")
    .eq("is_active", true)
    .maybeSingle();
  if (head.error) throw new Error(head.error.message);
  const roleIds = (head.data?.payment_process_role_ids ?? []).filter(Boolean);
  if (roleIds.length) {
    const profiles = await db().from("profiles")
      .select("id")
      .eq("company_id", account.companyId)
      .eq("is_active", true)
      .in("role_id", roleIds)
      .order("full_name")
      .limit(20);
    if (profiles.error) throw new Error(profiles.error.message);
    const match = (profiles.data ?? []).find((row) => !excludeUserIds.has(row.id));
    if (match) return { assignee_role: "finance_head", approver_user_id: match.id, approver_person_id: null };
  }

  const fallbackRoles = await db().from("user_roles")
    .select("id")
    .eq("company_id", account.companyId)
    .eq("is_active", true)
    .in("code", ["PAYROLL_APPROVER", "OWNER", "OWNER_BREAK_GLASS"]);
  if (fallbackRoles.error) throw new Error(fallbackRoles.error.message);
  const fallbackRoleIds = (fallbackRoles.data ?? []).map((role) => role.id);
  if (!fallbackRoleIds.length) return null;
  const fallbackProfiles = await db().from("profiles")
    .select("id")
    .eq("company_id", account.companyId)
    .eq("is_active", true)
    .in("role_id", fallbackRoleIds)
    .order("full_name")
    .limit(20);
  if (fallbackProfiles.error) throw new Error(fallbackProfiles.error.message);
  const match = (fallbackProfiles.data ?? []).find((row) => !excludeUserIds.has(row.id));
  return match ? { assignee_role: "finance_head", approver_user_id: match.id, approver_person_id: null } : null;
}

/** Single-layer dual assignee: reporting manager and/or finance head (first decision wins). */
export async function resolveExpenseClaimRequestAssignees(account: ConnectAccount) {
  const identity = await expenseIdentity(account);
  const assignees: ExpenseClaimRequestAssignee[] = [];
  const exclude = new Set<string>();
  if (identity.userId) exclude.add(identity.userId);

  const manager = await resolveImmediateReportingManager(account, identity);
  if (manager) {
    assignees.push(manager);
    exclude.add(manager.approver_user_id);
  }

  const finance = await resolveFinanceHeadAssignee(account, exclude);
  if (finance) assignees.push(finance);

  if (!assignees.length) {
    throw new Error("Configure a reporting manager or finance payment processor before requesting reimbursement approval.");
  }
  return { identity, assignees };
}

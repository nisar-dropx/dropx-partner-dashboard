import { sendConnectEmail } from "./connect-email";
import { todayInIndia } from "./india-date";
import { supabaseAdmin } from "./supabase-admin";

function fill(template: string, values: Record<string, string>) { return template.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (_, key: string) => values[key] ?? ""); }

type EmployeeExitNotice = { companyId: string; caseId: string; employee: { employee_code: string | null; full_name: string; email: string | null }; requestedDate: string };

async function notifyEmployeeExit(input: EmployeeExitNotice, eventCode: "CASE_SUBMITTED" | "WITHDRAWAL_REQUESTED") {
  if (!supabaseAdmin) return;
  const [{ data: template }, { data: exitCase }, { data: employeeProfile }, { data: access }] = await Promise.all([
    supabaseAdmin.from("hr_exit_notification_templates").select("*").eq("company_id", input.companyId).eq("event_code", eventCode).eq("is_enabled", true).maybeSingle(),
    supabaseAdmin.from("hr_exit_cases").select("case_number").eq("id", input.caseId).single(),
    input.employee.employee_code ? supabaseAdmin.from("profiles").select("reports_to_user_id").eq("company_id", input.companyId).eq("employee_id", input.employee.employee_code).maybeSingle() : Promise.resolve({ data: null }),
    supabaseAdmin.from("hr_user_access").select("user_id").eq("company_id", input.companyId).eq("is_active", true).in("role_code", ["HRMS_ADMIN","HR_MANAGER"])
  ]);
  if (!template || !exitCase) return;
  const hrIds = (access ?? []).map((row) => row.user_id);
  const [{ data: hrProfiles }, { data: ownerProfiles }, { data: manager }] = await Promise.all([
    hrIds.length ? supabaseAdmin.from("profiles").select("email").eq("company_id", input.companyId).in("id", hrIds).eq("is_active", true) : Promise.resolve({ data: [] }),
    supabaseAdmin.from("profiles").select("email").eq("company_id", input.companyId).eq("is_master_owner", true).eq("is_active", true),
    employeeProfile?.reports_to_user_id ? supabaseAdmin.from("profiles").select("email").eq("company_id", input.companyId).eq("id", employeeProfile.reports_to_user_id).maybeSingle() : Promise.resolve({ data: null })
  ]);
  const groups: Record<string, string[]> = { EMPLOYEE: input.employee.email ? [input.employee.email] : [], REPORTING_MANAGER: manager?.email ? [manager.email] : [], HR_TEAM: [...(hrProfiles ?? []), ...(ownerProfiles ?? [])].map((row) => row.email).filter(Boolean), HR_OWNER: [], TASK_OWNER: [] };
  const resolve = (roles: string[], custom: string[]) => Array.from(new Set([...roles.flatMap((role) => groups[role] ?? []), ...custom].map((email) => email.trim().toLowerCase()).filter(Boolean)));
  const to = resolve(template.to_recipients ?? [], template.custom_to_emails ?? []); const cc = resolve(template.cc_recipients ?? [], template.custom_cc_emails ?? []).filter((email) => !to.includes(email));
  const values = { case_number: exitCase.case_number, employee_name: input.employee.full_name, employee_code: input.employee.employee_code ?? "", requested_last_working_date: input.requestedDate, last_working_date: input.requestedDate };
  const subject = fill(template.subject_template, values); const body = fill(template.body_template, values);
  let status = "sent"; let errorMessage: string | null = null;
  try { if (!to.length) { status = "skipped"; errorMessage = "No recipients resolved."; } else await sendConnectEmail({ companyId: input.companyId, to, cc, subject, body }); }
  catch (error) { status = "failed"; errorMessage = error instanceof Error ? error.message : "Email failed."; }
  await supabaseAdmin.from("hr_exit_notification_log").insert({ company_id: input.companyId, case_id: input.caseId, event_code: eventCode, to_emails: to, cc_emails: cc, subject, status, error_message: errorMessage });
}

export async function notifyEmployeeExitSubmitted(input: EmployeeExitNotice) { return notifyEmployeeExit(input, "CASE_SUBMITTED"); }
export async function notifyEmployeeExitWithdrawal(input: EmployeeExitNotice) { return notifyEmployeeExit(input, "WITHDRAWAL_REQUESTED"); }

export async function notifyExitApprovalRequired(input: { companyId: string; caseId: string; approvalStepId: string }) {
  if (!supabaseAdmin) return;
  const [{ data: template }, { data: exitCase }, { data: approval }] = await Promise.all([
    supabaseAdmin.from("hr_exit_notification_templates").select("*").eq("company_id", input.companyId).eq("event_code", "APPROVAL_REQUIRED").eq("is_enabled", true).maybeSingle(),
    supabaseAdmin.from("hr_exit_cases").select("case_number, requested_last_working_date, personal_email, employees(employee_code, full_name, email)").eq("company_id", input.companyId).eq("id", input.caseId).maybeSingle(),
    supabaseAdmin.from("hr_exit_approvals").select("id, step_name, assigned_user_id, approver_role_id").eq("company_id", input.companyId).eq("case_id", input.caseId).eq("workflow_step_id", input.approvalStepId).eq("status", "pending").maybeSingle()
  ]);
  if (!template || !exitCase || !approval) return;
  const today = todayInIndia();
  const roleQueries = approval.approver_role_id ? await Promise.all([
    supabaseAdmin.from("hr_access_grants").select("user_id").eq("company_id", input.companyId).eq("role_id", approval.approver_role_id).eq("is_active", true).lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`),
    supabaseAdmin.from("hr_user_access").select("user_id").eq("company_id", input.companyId).eq("role_id", approval.approver_role_id).eq("is_active", true)
  ]) : [];
  const ownerIds = [...new Set([
    approval.assigned_user_id,
    ...roleQueries.flatMap((result) => (result.data ?? []).map((row) => row.user_id))
  ].filter((id): id is string => Boolean(id)))];
  const { data: owners } = ownerIds.length
    ? await supabaseAdmin.from("profiles").select("email").eq("company_id", input.companyId).eq("is_active", true).in("id", ownerIds)
    : { data: [] };
  const employee = Array.isArray(exitCase.employees) ? exitCase.employees[0] : exitCase.employees;
  const groups: Record<string, string[]> = {
    APPROVAL_OWNER: (owners ?? []).map((row) => row.email).filter(Boolean),
    EMPLOYEE: [exitCase.personal_email, employee?.email].map(String).filter(Boolean),
    REPORTING_MANAGER: [], HR_TEAM: [], HR_OWNER: [], TASK_OWNER: []
  };
  const resolve = (keys: string[], custom: string[]) => Array.from(new Set([...keys.flatMap((key) => groups[key] ?? []), ...custom].map((email) => email.trim().toLowerCase()).filter(Boolean)));
  const to = resolve(template.to_recipients ?? [], template.custom_to_emails ?? []);
  const cc = resolve(template.cc_recipients ?? [], template.custom_cc_emails ?? []).filter((email) => !to.includes(email));
  const values = {
    case_number: exitCase.case_number,
    employee_name: employee?.full_name ?? "Employee",
    employee_code: employee?.employee_code ?? "",
    requested_last_working_date: exitCase.requested_last_working_date ?? "",
    last_working_date: exitCase.requested_last_working_date ?? "",
    approval_step: approval.step_name,
    approval_decision: "pending"
  };
  const subject = fill(template.subject_template, values);
  const body = fill(template.body_template, values);
  let status = "sent";
  let errorMessage: string | null = null;
  try {
    if (!to.length) { status = "skipped"; errorMessage = "No active approval owner resolved."; }
    else await sendConnectEmail({ companyId: input.companyId, to, cc, subject, body });
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : "Email failed.";
  }
  await supabaseAdmin.from("hr_exit_notification_log").insert({ company_id: input.companyId, case_id: input.caseId, event_code: "APPROVAL_REQUIRED", to_emails: to, cc_emails: cc, subject, status, error_message: errorMessage });
}

export async function notifyConnectExitOutcome(input: { companyId: string; caseId: string; event: "CASE_APPROVED" | "CASE_REJECTED" }) {
  if (!supabaseAdmin) return { status: "skipped" as const, error: "Database is unavailable." };
  const [{ data: template }, { data: exitCase }] = await Promise.all([
    supabaseAdmin.from("hr_exit_notification_templates").select("*").eq("company_id", input.companyId).eq("event_code", input.event).eq("is_enabled", true).maybeSingle(),
    supabaseAdmin.from("hr_exit_cases").select("case_number,requested_last_working_date,approved_last_working_date,personal_email,worker_type,employees(employee_code,full_name,email),contractors(dropx_id,full_name,email)").eq("company_id", input.companyId).eq("id", input.caseId).maybeSingle()
  ]);
  if (!template || !exitCase) return { status: "skipped" as const };
  const employee = Array.isArray(exitCase.employees) ? exitCase.employees[0] : exitCase.employees;
  const contractor = Array.isArray(exitCase.contractors) ? exitCase.contractors[0] : exitCase.contractors;
  const worker = exitCase.worker_type === "contractor" ? contractor : employee;
  const workerCode = exitCase.worker_type === "contractor" ? contractor?.dropx_id : employee?.employee_code;
  const to = Array.from(new Set([exitCase.personal_email, worker?.email].map((email) => String(email ?? "").trim().toLowerCase()).filter(Boolean)));
  const values = {
    case_number: exitCase.case_number,
    employee_name: worker?.full_name ?? "Team member",
    employee_code: workerCode ?? "",
    requested_last_working_date: exitCase.requested_last_working_date ?? "",
    last_working_date: exitCase.approved_last_working_date ?? exitCase.requested_last_working_date ?? "",
    approval_step: "",
    approval_decision: input.event === "CASE_APPROVED" ? "approved" : "rejected"
  };
  const subject = fill(template.subject_template, values);
  const body = fill(template.body_template, values);
  let status: "sent" | "failed" | "skipped" = "sent";
  let errorMessage: string | null = null;
  try {
    if (!to.length) { status = "skipped"; errorMessage = "The requester has no email address."; }
    else await sendConnectEmail({ companyId: input.companyId, to, subject, body });
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : "Email failed.";
  }
  await supabaseAdmin.from("hr_exit_notification_log").insert({ company_id: input.companyId, case_id: input.caseId, event_code: input.event, to_emails: to, cc_emails: [], subject, status, error_message: errorMessage });
  return { status, error: errorMessage };
}

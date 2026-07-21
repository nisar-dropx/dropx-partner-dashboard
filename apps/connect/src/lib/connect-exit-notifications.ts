import { sendConnectEmail } from "./connect-email";
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

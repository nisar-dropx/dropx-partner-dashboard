import { NextResponse } from "next/server";
import { requireConnectAccount } from "../../../../src/lib/connect-auth";
import { notifyEmployeeExitSubmitted, notifyEmployeeExitWithdrawal } from "../../../../src/lib/connect-exit-notifications";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database is unavailable."); return supabaseAdmin; }
function clean(value: unknown) { return String(value ?? "").trim(); }
async function roleUser(companyId: string, employeeCode: string | null, role: string) {
  if (role === "REPORTING_MANAGER" && employeeCode) {
    const { data } = await db().from("profiles").select("reports_to_user_id").eq("company_id", companyId).eq("employee_id", employeeCode).maybeSingle(); return data?.reports_to_user_id ?? null;
  }
  if (["HR_MANAGER","HRMS_ADMIN"].includes(role)) { const { data } = await db().from("hr_user_access").select("user_id").eq("company_id", companyId).eq("role_code", role).eq("is_active", true).limit(1).maybeSingle(); return data?.user_id ?? null; }
  if (role === "OWNER") { const { data } = await db().from("profiles").select("id").eq("company_id", companyId).eq("is_master_owner", true).eq("is_active", true).limit(1).maybeSingle(); return data?.id ?? null; }
  return null;
}
async function serializeCase(row: Record<string, any>) {
  const { data: tasks } = await db().from("hr_exit_tasks").select("id, category, name, due_date, status, is_required").eq("case_id", row.id).order("created_at");
  const { data: documents } = await db().from("hr_exit_documents").select("id, document_type, file_name, status, generated_at, storage_path").eq("case_id", row.id).neq("status", "void").order("generated_at", { ascending: false });
  const safeDocuments = await Promise.all((documents ?? []).map(async (document) => { const { data } = await db().storage.from("hr-exit-documents").createSignedUrl(document.storage_path, 15 * 60); return { id: document.id, type: document.document_type, name: document.file_name, status: document.status, generatedAt: document.generated_at, downloadUrl: data?.signedUrl ?? "" }; }));
  const reason = Array.isArray(row.hr_exit_reasons) ? row.hr_exit_reasons[0] : row.hr_exit_reasons;
  return { id: row.id, caseNumber: row.case_number, scenario: row.scenario, status: row.status, stage: row.current_stage, reason: reason?.name ?? "", comments: row.employee_reason ?? "", requestedLastWorkingDate: row.requested_last_working_date, approvedLastWorkingDate: row.approved_last_working_date, submittedAt: row.submitted_at, settlementStatus: row.settlement_status, tasks: tasks ?? [], documents: safeDocuments };
}

export async function GET(request: Request) {
  try {
    const employeeId = new URL(request.url).searchParams.get("employeeId") ?? "";
    const account = await requireConnectAccount("employee", employeeId);
    const [{ data: policy }, { data: reasons }, { data: exitCase }] = await Promise.all([
      db().from("hr_exit_policies").select("resignation_notice_days, withdrawal_allowed").eq("company_id", account.companyId).maybeSingle(),
      db().from("hr_exit_reasons").select("id, name, comment_required").eq("company_id", account.companyId).eq("scenario", "resignation").eq("employee_selectable", true).eq("is_active", true).order("display_order"),
      db().from("hr_exit_cases").select("*, hr_exit_reasons(name)").eq("company_id", account.companyId).eq("employee_id", account.id).order("submitted_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    return NextResponse.json({ ok: true, policy: policy ?? { resignation_notice_days: 30, withdrawal_allowed: true }, reasons: reasons ?? [], exitCase: exitCase ? await serializeCase(exitCase) : null });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load exit request." }, { status: 400 }); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json(); const employeeId = clean(body.employeeId); const action = clean(body.action || "submit");
    const account = await requireConnectAccount("employee", employeeId);
    if (action === "withdraw") {
      const [{ data: policy }, { data: exitCase }] = await Promise.all([
        db().from("hr_exit_policies").select("withdrawal_allowed").eq("company_id", account.companyId).maybeSingle(),
        db().from("hr_exit_cases").select("id, case_number, status, requested_last_working_date").eq("company_id", account.companyId).eq("employee_id", account.id).not("status", "in", '("closed","rejected","withdrawn","cancelled")').order("submitted_at", { ascending: false }).limit(1).maybeSingle()
      ]);
      if (!policy?.withdrawal_allowed) throw new Error("Withdrawal requests are disabled by company policy.");
      if (!exitCase || ["documents_ready","closed"].includes(exitCase.status)) throw new Error("This exit request can no longer be withdrawn.");
      const updated = await db().from("hr_exit_cases").update({ status: "withdrawal_requested", updated_at: new Date().toISOString() }).eq("id", exitCase.id); if (updated.error) throw new Error(updated.error.message);
      await db().from("hr_exit_events").insert({ company_id: account.companyId, case_id: exitCase.id, event_code: "WITHDRAWAL_REQUESTED", title: "Employee requested resignation withdrawal", actor_name: account.name ?? "Employee", details: {} });
      const { data: employee } = await db().from("employees").select("employee_code, full_name, email").eq("company_id", account.companyId).eq("id", account.id).single();
      if (employee) await notifyEmployeeExitWithdrawal({ companyId: account.companyId, caseId: exitCase.id, employee, requestedDate: exitCase.requested_last_working_date ?? "" });
      return NextResponse.json({ ok: true, notice: "Withdrawal request sent to HR and your reporting manager." });
    }
    const reasonId = clean(body.reasonId); const comments = clean(body.comments); const requestedDate = clean(body.requestedLastWorkingDate); const personalEmail = clean(body.personalEmail) || account.email; const personalMobile = clean(body.personalMobile);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) throw new Error("Select a requested last working date.");
    const today = new Date(); today.setHours(0,0,0,0); const date = new Date(`${requestedDate}T00:00:00`); const max = new Date(today); max.setFullYear(max.getFullYear() + 1);
    if (date < today || date > max) throw new Error("Requested last working date must be between today and one year from today.");
    const [{ data: employee }, { data: reason }, { data: policy }, { data: existing }] = await Promise.all([
      db().from("employees").select("id, company_id, employee_code, full_name, email, mobile, is_active").eq("company_id", account.companyId).eq("id", account.id).maybeSingle(),
      db().from("hr_exit_reasons").select("id, name, comment_required, default_rehire_eligible").eq("company_id", account.companyId).eq("scenario", "resignation").eq("employee_selectable", true).eq("is_active", true).eq("id", reasonId).maybeSingle(),
      db().from("hr_exit_policies").select("*").eq("company_id", account.companyId).maybeSingle(),
      db().from("hr_exit_cases").select("id").eq("company_id", account.companyId).eq("employee_id", account.id).not("status", "in", '("closed","rejected","withdrawn","cancelled")').limit(1)
    ]);
    if (!employee?.is_active || !reason) throw new Error("Employee or resignation reason is unavailable.");
    if (reason.comment_required && comments.length < 3) throw new Error("Comments are required for this resignation reason.");
    if (existing?.length) throw new Error("An active exit request already exists.");
    const { data: caseNumber, error: numberError } = await db().rpc("hr_next_exit_case_number", { p_company_id: account.companyId, p_prefix: policy?.case_number_prefix ?? "EXIT" }); if (numberError) throw new Error(numberError.message);
    const managerId = await roleUser(account.companyId, employee.employee_code, "REPORTING_MANAGER");
    const { data: exitCase, error } = await db().from("hr_exit_cases").insert({ company_id: account.companyId, case_number: caseNumber, employee_id: account.id, source: "employee", scenario: "resignation", reason_id: reason.id, employee_reason: comments || null, requested_last_working_date: requestedDate, notice_days: policy?.resignation_notice_days ?? 30, status: "submitted", current_stage: "review", manager_user_id: managerId, personal_email: personalEmail || null, personal_mobile: personalMobile || employee.mobile, rehire_eligible: reason.default_rehire_eligible }).select("id").single(); if (error) throw new Error(error.message);
    const { data: steps } = await db().from("hr_exit_workflow_steps").select("*").eq("company_id", account.companyId).eq("scenario", "resignation").eq("is_active", true).order("step_order");
    if (steps?.length) { const rows = await Promise.all(steps.map(async (step) => ({ company_id: account.companyId, case_id: exitCase.id, workflow_step_id: step.id, step_order: step.step_order, step_name: step.name, approver_role: step.approver_role, assigned_user_id: await roleUser(account.companyId, employee.employee_code, step.approver_role), is_required: step.is_required }))); const inserted = await db().from("hr_exit_approvals").insert(rows); if (inserted.error) throw new Error(inserted.error.message); }
    if (policy?.auto_create_tasks !== false) { const { data: templates } = await db().from("hr_exit_task_templates").select("*").eq("company_id", account.companyId).eq("is_active", true).in("scenario", ["resignation","all"]).order("display_order"); if (templates?.length) { const rows = await Promise.all(templates.map(async (template) => { const due = new Date(`${requestedDate}T00:00:00Z`); due.setUTCDate(due.getUTCDate() + template.due_offset_days); return { company_id: account.companyId, case_id: exitCase.id, template_id: template.id, category: template.category, code: template.code, name: template.name, instructions: template.instructions, owner_role: template.owner_role, owner_user_id: template.owner_role === "EMPLOYEE" ? null : await roleUser(account.companyId, employee.employee_code, template.owner_role), due_date: due.toISOString().slice(0,10), is_required: template.is_required }; })); const inserted = await db().from("hr_exit_tasks").insert(rows); if (inserted.error) throw new Error(inserted.error.message); } }
    await db().from("hr_exit_events").insert({ company_id: account.companyId, case_id: exitCase.id, event_code: "CASE_SUBMITTED", title: "Resignation submitted in DropX One", actor_name: account.name ?? "Employee", details: { requested_last_working_date: requestedDate } });
    await notifyEmployeeExitSubmitted({ companyId: account.companyId, caseId: exitCase.id, employee, requestedDate });
    return NextResponse.json({ ok: true, notice: `Resignation submitted successfully. Case ${caseNumber} has been sent for review.` });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit exit request." }, { status: 400 }); }
}

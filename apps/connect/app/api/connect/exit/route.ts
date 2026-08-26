import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { notifyEmployeeExitSubmitted, notifyEmployeeExitWithdrawal } from "../../../../src/lib/connect-exit-notifications";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

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

async function reportingManagerUser(context: WorkerContext) {
  const sourceColumn = context.workerType === "contractor" ? "contractor_id" : "employee_id";
  const today = new Date().toISOString().slice(0, 10);
  const { data: engagement } = await db().from("hr_engagements")
    .select("id")
    .eq("company_id", context.account.companyId)
    .eq(sourceColumn, context.workerId)
    .eq("status", "active")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
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
      const { data: relationship } = await db().from("hr_reporting_relationships")
        .select("manager_assignment_id")
        .eq("company_id", context.account.companyId)
        .eq("subject_assignment_id", assignment.id)
        .eq("relationship_type", "solid_line")
        .eq("is_primary", true)
        .lte("effective_from", today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (relationship?.manager_assignment_id) {
        const { data: managerAssignment } = await db().from("hr_work_assignments")
          .select("engagement_id")
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
            const { data: link } = await db().from("hr_user_person_links")
              .select("user_id")
              .eq("company_id", context.account.companyId)
              .eq("person_id", managerEngagement.person_id)
              .eq("status", "active")
              .maybeSingle();
            if (link?.user_id) return link.user_id;
          }
        }
      }
    }
  }

  if (context.workerType === "employee" && context.worker.employee_code) {
    const { data: profile } = await db().from("profiles")
      .select("reports_to_user_id")
      .eq("company_id", context.account.companyId)
      .eq("employee_id", context.worker.employee_code)
      .maybeSingle();
    return profile?.reports_to_user_id ?? null;
  }
  return null;
}

async function roleUser(context: WorkerContext, role: string) {
  if (role === "REPORTING_MANAGER") return reportingManagerUser(context);
  if (["HR_MANAGER", "HRMS_ADMIN"].includes(role)) {
    const { data } = await db().from("hr_user_access")
      .select("user_id")
      .eq("company_id", context.account.companyId)
      .eq("role_code", role)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    return data?.user_id ?? null;
  }
  if (role === "OWNER") {
    const { data } = await db().from("profiles")
      .select("id")
      .eq("company_id", context.account.companyId)
      .eq("is_master_owner", true)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  }
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
    db().from("hr_exit_approvals").select("id, step_order, step_name, approver_role, status, comments, acted_at, created_at").eq("case_id", row.id).order("step_order")
  ]);
  const safeDocuments = await Promise.all((documents ?? []).map(async (document) => {
    if (!document.storage_path) return { id: document.id, type: document.document_type, name: document.file_name, status: document.status, generatedAt: document.generated_at, downloadUrl: "" };
    const { data } = await db().storage.from("hr-exit-documents").createSignedUrl(document.storage_path, 15 * 60);
    return { id: document.id, type: document.document_type, name: document.file_name, status: document.status, generatedAt: document.generated_at, downloadUrl: data?.signedUrl ?? "" };
  }));
  const reason = Array.isArray(row.hr_exit_reasons) ? row.hr_exit_reasons[0] : row.hr_exit_reasons;
  const timeline = [
    ...(events ?? []).map((event) => ({ id: `event-${event.id}`, title: event.title || event.event_code.replaceAll("_", " "), status: "completed", createdAt: event.created_at, actorName: event.actor_name, note: typeof event.details?.note === "string" ? event.details.note : null })),
    ...(approvals ?? []).map((approval) => ({ id: `approval-${approval.id}`, title: approval.step_name, status: approval.status === "pending" ? "pending" : "completed", createdAt: approval.acted_at || approval.created_at, actorName: approval.approver_role.replaceAll("_", " "), note: approval.comments }))
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
    return NextResponse.json({
      ok: true,
      flow: "people",
      destination: context.workerType === "contractor" ? "People · Individual contractor exit" : "People · Employee exit",
      policy: policyResult.data ?? { resignation_notice_days: 30, withdrawal_allowed: true },
      reasons: reasonsResult.data ?? [],
      exitCase: caseResult.data ? await serializeCase(caseResult.data) : null
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
      if (!exitCase || ["documents_ready", "closed"].includes(exitCase.status)) throw new Error("This exit request can no longer be withdrawn.");
      const updated = await db().from("hr_exit_cases").update({ status: "withdrawal_requested", updated_at: new Date().toISOString() }).eq("id", exitCase.id);
      if (updated.error) throw new Error(updated.error.message);
      await db().from("hr_exit_events").insert({ company_id: context.account.companyId, case_id: exitCase.id, event_code: "WITHDRAWAL_REQUESTED", title: "Withdrawal requested", actor_name: context.account.name ?? context.worker.full_name, details: {} });
      await notifyEmployeeExitWithdrawal({ companyId: context.account.companyId, caseId: exitCase.id, employee: context.worker, requestedDate: exitCase.requested_last_working_date ?? "" });
      return NextResponse.json({ ok: true, notice: "Withdrawal request sent to the configured reviewers." });
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
      caseQuery(context).not("status", "in", '("closed","rejected","withdrawn","cancelled")').limit(1)
    ]);
    if (reasonResult.error || policyResult.error || existingResult.error) throw new Error(reasonResult.error?.message ?? policyResult.error?.message ?? existingResult.error?.message ?? "Unable to validate exit request.");
    if (!context.worker.is_active || !reasonResult.data) throw new Error("Profile or resignation reason is unavailable.");
    if (reasonResult.data.comment_required && comments.length < 3) throw new Error("Comments are required for this resignation reason.");
    if (existingResult.data?.length) throw new Error("An active exit request already exists.");

    const { data: steps, error: stepsError } = await db().from("hr_exit_workflow_steps").select("*").eq("company_id", context.account.companyId).eq("scenario", "resignation").eq("is_active", true).order("step_order");
    if (stepsError) throw new Error(stepsError.message);
    const approvalRows = await Promise.all((steps ?? []).map(async (step) => ({
      company_id: context.account.companyId,
      workflow_step_id: step.id,
      step_order: step.step_order,
      step_name: step.name,
      approver_role: step.approver_role,
      assigned_user_id: await roleUser(context, step.approver_role),
      is_required: step.is_required
    })));
    const unresolved = approvalRows.find((step) => step.is_required && !step.assigned_user_id);
    if (unresolved) throw new Error(`${unresolved.step_name} does not have a configured approver. Ask the People team to update the reporting or access setup.`);

    const { data: caseNumber, error: numberError } = await db().rpc("hr_next_exit_case_number", { p_company_id: context.account.companyId, p_prefix: policyResult.data?.case_number_prefix ?? "EXIT" });
    if (numberError) throw new Error(numberError.message);
    const managerId = await reportingManagerUser(context);
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
          return { company_id: context.account.companyId, case_id: exitCase.id, template_id: template.id, category: template.category, code: template.code, name: template.name, instructions: template.instructions, owner_role: template.owner_role, owner_user_id: template.owner_role === "EMPLOYEE" ? null : await roleUser(context, template.owner_role), due_date: due.toISOString().slice(0, 10), is_required: template.is_required };
        }));
        const inserted = await db().from("hr_exit_tasks").insert(rows);
        if (inserted.error) throw new Error(inserted.error.message);
      }
    }
    await db().from("hr_exit_events").insert({ company_id: context.account.companyId, case_id: exitCase.id, event_code: "CASE_SUBMITTED", title: "Resignation submitted", actor_name: context.account.name ?? context.worker.full_name, details: { requested_last_working_date: requestedDate } });
    await notifyEmployeeExitSubmitted({ companyId: context.account.companyId, caseId: exitCase.id, employee: context.worker, requestedDate });
    return NextResponse.json({ ok: true, notice: `Resignation submitted successfully. Case ${caseNumber} has been sent for review.` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit exit request." }, { status: 400 });
  }
}

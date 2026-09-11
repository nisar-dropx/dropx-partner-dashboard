import "server-only";

import { isManagingPartnerDesignation, isWfhHardBlockedDesignation } from "./approval-designation-labels";
import { resolveConfiguredApprovalWorkflow } from "./configured-approval-routing";
import type { ConnectAccount } from "./connect-auth";
import {
  connectWorkforceMatches,
  loadConnectAccessibleWorkforceIds,
  loadConnectAttendanceApproveScope
} from "./connect-people-attendance-access";
import {
  connectBusinessTripEligible,
  loadConnectBusinessTripPolicies,
  type ConnectBusinessTripPolicy
} from "./connect-business-trip-access";
import { notifyApproverMobile } from "./approver-mobile-notifications";
import { supabaseAdmin } from "./supabase-admin";

export type BusinessTripWorkerType = "employee" | "contractor";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
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

function daysBetween(fromDate: string, toDate: string) {
  return Math.floor((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1;
}

async function activeWorkforceContext(companyId: string, workerId: string, workerType: BusinessTripWorkerType) {
  const today = indiaToday();
  const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
  const engagementResult = await db().from("hr_engagements").select("id,person_id,status")
    .eq("company_id", companyId).eq("worker_type", workerType).eq(workerColumn, workerId).maybeSingle();
  if (engagementResult.error || !engagementResult.data || engagementResult.data.status !== "active") {
    throw new Error(engagementResult.error?.message ?? "Your active People engagement is not configured.");
  }
  const assignmentResult = await db().from("hr_work_assignments")
    .select("id,business_line,position_title,location_id,designation_id,is_top_level,effective_from,effective_to")
    .eq("company_id", companyId).eq("engagement_id", engagementResult.data.id).eq("is_primary", true)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignmentResult.error || !assignmentResult.data) {
    throw new Error(assignmentResult.error?.message ?? "Your active work assignment is not configured.");
  }
  return { today, engagement: engagementResult.data, assignment: assignmentResult.data };
}

async function workerIdentity(companyId: string, workerId: string, workerType: BusinessTripWorkerType) {
  if (workerType === "employee") {
    const result = await db().from("employees")
      .select("full_name,employee_code,designation_id")
      .eq("company_id", companyId).eq("id", workerId).maybeSingle();
    if (result.error || !result.data) throw new Error(result.error?.message ?? "Employee profile was not found.");
    return {
      workerName: String(result.data.full_name ?? "Worker"),
      workerCode: String(result.data.employee_code ?? ""),
      designationId: result.data.designation_id as string | null
    };
  }
  const result = await db().from("contractors")
    .select("full_name,dropx_id,designation")
    .eq("company_id", companyId).eq("id", workerId).maybeSingle();
  if (result.error || !result.data) throw new Error(result.error?.message ?? "Contractor profile was not found.");
  return {
    workerName: String(result.data.full_name ?? "Worker"),
    workerCode: String(result.data.dropx_id ?? ""),
    designationId: null as string | null
  };
}

async function designationLabel(companyId: string, designationId: string | null) {
  if (!designationId) return null;
  const result = await db().from("designations").select("id,code,name")
    .eq("company_id", companyId).eq("id", designationId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return null;
  return { name: String(result.data.name ?? ""), code: result.data.code ? String(result.data.code) : null };
}

async function nextBusinessTripRequestNo(companyId: string) {
  const prefix = `SV-${indiaToday().replace(/-/g, "").slice(0, 6)}-`;
  const result = await db().from("hr_business_trip_requests")
    .select("request_no")
    .eq("company_id", companyId)
    .like("request_no", `${prefix}%`)
    .order("request_no", { ascending: false })
    .limit(1);
  if (result.error) throw new Error(result.error.message);
  const latest = result.data?.[0]?.request_no as string | undefined;
  const sequence = latest?.startsWith(prefix) ? Number(latest.slice(prefix.length)) : 0;
  const next = Number.isFinite(sequence) ? sequence + 1 : 1;
  return `${prefix}${String(next).padStart(5, "0")}`;
}

async function resolveBusinessTripManagerSteps(input: {
  companyId: string;
  workerId: string;
  workerType: BusinessTripWorkerType;
  asOf: string;
}) {
  // Prefer dedicated business_trip routes; fall back to WFH route shape with peer scopes stripped.
  for (const workflowCode of ["business_trip", "work_from_home"] as const) {
    const configured = await resolveConfiguredApprovalWorkflow({
      companyId: input.companyId,
      workflowCode,
      workerId: input.workerId,
      workerType: input.workerType,
      asOf: input.asOf,
      maxLevel: 2,
      reportingChainOnly: true,
      allowMissingApprovers: true
    });
    if (configured) {
      return {
        routeName: workflowCode === "business_trip" ? configured.routeName : "Reporting manager (business trip)",
        steps: configured.steps.map((step) => ({
          step_name: step.step_name,
          approver_user_id: step.approver_user_id,
          approver_person_id: step.approver_person_id,
          approver_name: step.approver_name
        }))
      };
    }
  }
  return { routeName: "HR finalization", steps: [] as Array<{
    step_name: string;
    approver_user_id: string;
    approver_person_id: string;
    approver_name: string;
  }> };
}

export async function assertConnectBusinessTripAccess(companyId: string, workerId: string, workerType: BusinessTripWorkerType) {
  const context = await activeWorkforceContext(companyId, workerId, workerType);
  const designationId = context.assignment.designation_id as string | null;
  const [policies, label] = await Promise.all([
    loadConnectBusinessTripPolicies([companyId]),
    designationLabel(companyId, designationId)
  ]);
  const policy = policies.get(companyId) ?? null;
  if (!connectBusinessTripEligible({ policy, designationId, designation: label })) {
    if (isWfhHardBlockedDesignation(label)) {
      throw new Error("Business trip is not available for Team Lead, Station Manager, or Store Manager roles.");
    }
    throw new Error("Business trip is not enabled for your designation. Ask HR to grant access in the Business Trip policy.");
  }
  return { context, policy: policy as ConnectBusinessTripPolicy, designationId, designation: label };
}

export async function listConnectBusinessTripRequests(companyId: string, workerId: string, workerType: BusinessTripWorkerType) {
  const access = await assertConnectBusinessTripAccess(companyId, workerId, workerType);
  const result = await db().from("hr_business_trip_requests")
    .select("id,request_no,start_date,end_date,reason,status,manager_name,manager_note,hr_note,hr_reviewer_name,requested_at,applied_dates,skipped_dates")
    .eq("company_id", companyId)
    .eq("profile_type", workerType)
    .eq("profile_id", workerId)
    .order("requested_at", { ascending: false })
    .limit(50);
  if (result.error) {
    if (/does not exist|schema cache/i.test(result.error.message)) {
      return {
        policy: {
          enabled: access.policy.is_enabled,
          maxRequestDays: access.policy.max_request_days,
          allowBackdated: access.policy.allow_backdated,
          requiresHrFinalization: access.policy.requires_hr_finalization
        },
        requests: [],
        summary: { pending: 0 }
      };
    }
    throw new Error(result.error.message);
  }
  return {
    policy: {
      enabled: access.policy.is_enabled,
      maxRequestDays: access.policy.max_request_days,
      allowBackdated: access.policy.allow_backdated,
      requiresHrFinalization: access.policy.requires_hr_finalization
    },
    requests: (result.data ?? []).map((request) => ({
      id: request.id,
      requestNo: request.request_no,
      fromDate: request.start_date,
      toDate: request.end_date,
      days: daysBetween(String(request.start_date), String(request.end_date)),
      reason: request.reason,
      status: request.status,
      managerName: request.manager_name,
      managerNote: request.manager_note,
      hrNote: request.hr_note,
      hrReviewerName: request.hr_reviewer_name,
      requestedAt: request.requested_at,
      appliedDates: request.applied_dates ?? [],
      skippedDates: request.skipped_dates ?? []
    })),
    summary: {
      pending: (result.data ?? []).filter((item) => ["pending_manager", "pending_hr"].includes(String(item.status))).length
    }
  };
}

export async function createConnectBusinessTripRequest(input: {
  companyId: string;
  workerId: string;
  workerType: BusinessTripWorkerType;
  fromDate: string;
  toDate: string;
  reason: string;
}) {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1000) throw new Error("Enter a valid reason between 3 and 1,000 characters.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.toDate)) {
    throw new Error("Select the business trip dates.");
  }
  if (input.toDate < input.fromDate) throw new Error("The end date cannot be before the start date.");
  const days = daysBetween(input.fromDate, input.toDate);
  const access = await assertConnectBusinessTripAccess(input.companyId, input.workerId, input.workerType);
  if (days > access.policy.max_request_days) {
    throw new Error(`A business trip request can cover at most ${access.policy.max_request_days} day(s).`);
  }
  const today = access.context.today;
  if (!access.policy.allow_backdated && input.fromDate < today) {
    throw new Error("Backdated business trip requests are not allowed.");
  }

  const overlap = await db().from("hr_business_trip_requests")
    .select("id")
    .eq("company_id", input.companyId)
    .eq("profile_type", input.workerType)
    .eq("profile_id", input.workerId)
    .in("status", ["pending_manager", "pending_hr", "approved"])
    .lte("start_date", input.toDate)
    .gte("end_date", input.fromDate)
    .limit(1);
  if (overlap.error) throw new Error(overlap.error.message);
  if (overlap.data?.length) throw new Error("A pending or approved business trip request already overlaps these dates.");

  const identity = await workerIdentity(input.companyId, input.workerId, input.workerType);
  const designationId = access.designationId ?? identity.designationId;
  const requesterLink = await db().from("hr_user_person_links").select("user_id,status")
    .eq("company_id", input.companyId).eq("person_id", access.context.engagement.person_id).maybeSingle();
  if (requesterLink.error) throw new Error(requesterLink.error.message);
  const requesterUserId = requesterLink.data?.status === "active" ? requesterLink.data.user_id : null;

  let steps: Array<{
    step_name: string;
    approver_user_id: string;
    approver_person_id: string;
    approver_name: string;
  }> = [];
  let routeName = "Reporting manager";
  const skipManagerChain = Boolean(access.context.assignment.is_top_level)
    || isManagingPartnerDesignation(access.designation);

  if (!skipManagerChain) {
    const configured = await resolveBusinessTripManagerSteps({
      companyId: input.companyId,
      workerId: input.workerId,
      workerType: input.workerType,
      asOf: today
    });
    routeName = configured.routeName;
    steps = configured.steps;
  } else {
    routeName = "Managing partner / top-level";
  }

  const requestNo = await nextBusinessTripRequestNo(input.companyId);
  const first = steps[0] ?? null;
  const status = first ? "pending_manager" : "pending_hr";
  const insertResult = await db().from("hr_business_trip_requests").insert({
    company_id: input.companyId,
    request_no: requestNo,
    profile_type: input.workerType,
    profile_id: input.workerId,
    person_id: access.context.engagement.person_id,
    assignment_id: access.context.assignment.id,
    designation_id: designationId,
    location_id: access.context.assignment.location_id,
    worker_code: identity.workerCode || null,
    worker_name: identity.workerName,
    start_date: input.fromDate,
    end_date: input.toDate,
    reason,
    status,
    requested_by: requesterUserId,
    manager_user_id: first?.approver_user_id ?? null,
    manager_person_id: first?.approver_person_id ?? null,
    manager_name: first?.approver_name ?? null
  }).select("id").single();
  if (insertResult.error) throw new Error(insertResult.error.message);
  const requestId = insertResult.data.id as string;

  if (steps.length) {
    const stepRows = steps.map((step, index) => ({
      company_id: input.companyId,
      request_id: requestId,
      step_order: index + 1,
      step_name: step.step_name,
      approver_user_id: step.approver_user_id,
      approver_person_id: step.approver_person_id,
      approver_name: step.approver_name,
      status: index === 0 ? "pending" : "queued"
    }));
    const stepsResult = await db().from("hr_business_trip_approval_steps").insert(stepRows);
    if (stepsResult.error) {
      await db().from("hr_business_trip_requests").delete().eq("id", requestId);
      throw new Error(stepsResult.error.message);
    }
    const firstApprover = stepRows[0]?.approver_user_id;
    if (firstApprover) {
      await notifyApproverMobile({
        companyId: input.companyId,
        recipientUserId: firstApprover,
        eventCode: "SITE_VISIT_APPROVAL_REQUIRED",
        title: "Business trip needs approval",
        body: `${identity.workerName || "Team member"} requested a business trip (${input.fromDate} – ${input.toDate}). Open Approval Inbox.`,
        route: "approvals",
        sourceKey: requestId,
        data: { businessTripRequestId: requestId }
      });
    }
  }

  return {
    requestId,
    requestNo,
    status,
    notice: status === "pending_hr"
      ? "Business trip request submitted for HR finalization."
      : `Business trip request submitted to ${routeName}. Peer approvals are skipped — your reporting manager will review it next.`
  };
}

export async function cancelConnectBusinessTripRequest(input: {
  companyId: string;
  workerId: string;
  workerType: BusinessTripWorkerType;
  requestId: string;
}) {
  if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new Error("Business trip request is invalid.");
  await assertConnectBusinessTripAccess(input.companyId, input.workerId, input.workerType);
  const existing = await db().from("hr_business_trip_requests")
    .select("id,status")
    .eq("company_id", input.companyId)
    .eq("id", input.requestId)
    .eq("profile_type", input.workerType)
    .eq("profile_id", input.workerId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) throw new Error("Business trip request was not found.");
  if (!["pending_manager", "returned"].includes(String(existing.data.status))) {
    throw new Error("Only pending or returned business trip requests can be withdrawn.");
  }
  const update = await db().from("hr_business_trip_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", input.requestId);
  if (update.error) throw new Error(update.error.message);
  await db().from("hr_business_trip_approval_steps")
    .update({ status: "skipped", updated_at: new Date().toISOString() })
    .eq("request_id", input.requestId)
    .in("status", ["pending", "queued"]);
  return { notice: "Business trip request withdrawn." };
}

export async function listConnectBusinessTripApprovals(input: {
  companyId: string;
  approverUserId?: string;
  approverUserIds?: string[];
  matchesReportee: (profileType: string, profileId: string | null) => boolean;
}) {
  const approverIds = [...new Set([
    ...(input.approverUserIds ?? []),
    ...(input.approverUserId ? [input.approverUserId] : [])
  ].filter(Boolean))];
  if (!approverIds.length) return [];
  const stepResult = await db().from("hr_business_trip_approval_steps")
    .select("id,request_id,step_order,step_name,status")
    .eq("company_id", input.companyId)
    .in("approver_user_id", approverIds)
    .eq("status", "pending")
    .order("created_at");
  if (stepResult.error) {
    if (/does not exist|schema cache/i.test(stepResult.error.message)) return [];
    throw new Error(stepResult.error.message);
  }
  const steps = stepResult.data ?? [];
  if (!steps.length) return [];
  const requestResult = await db().from("hr_business_trip_requests")
    .select("id,request_no,profile_type,profile_id,worker_code,worker_name,start_date,end_date,reason,status")
    .eq("company_id", input.companyId)
    .eq("status", "pending_manager")
    .in("id", steps.map((step) => step.request_id));
  if (requestResult.error) throw new Error(requestResult.error.message);
  const stepByRequest = new Map(steps.map((step) => [step.request_id, step]));
  return (requestResult.data ?? []).flatMap((request) => {
    if (!input.matchesReportee(String(request.profile_type), request.profile_id as string | null)) return [];
    const step = stepByRequest.get(request.id);
    if (!step) return [];
    return [{
      id: step.id,
      requestId: request.id,
      requestNo: request.request_no,
      stepName: step.step_name,
      stepOrder: step.step_order,
      startDate: request.start_date,
      endDate: request.end_date,
      days: daysBetween(String(request.start_date), String(request.end_date)),
      reason: request.reason,
      requesterName: request.worker_name,
      requesterCode: request.worker_code ?? "",
      profileType: request.profile_type
    }];
  });
}

export async function decideConnectBusinessTripApproval(input: {
  companyId: string;
  approverUserId: string;
  requestId: string;
  decision: "approved" | "rejected";
  note?: string;
}) {
  const result = await db().rpc("hr_decide_business_trip_manager", {
    p_company_id: input.companyId,
    p_request_id: input.requestId,
    p_actor_user_id: input.approverUserId,
    p_decision: input.decision,
    p_note: input.note ?? null
  });
  if (result.error) throw new Error(result.error.message);
  const status = String(result.data ?? "");
  if (status === "pending_manager") {
    const next = await db().from("hr_business_trip_approval_steps")
      .select("approver_user_id,request_id")
      .eq("company_id", input.companyId)
      .eq("request_id", input.requestId)
      .eq("status", "pending")
      .order("step_order")
      .limit(1)
      .maybeSingle();
    if (!next.error && next.data?.approver_user_id) {
      const request = await db().from("hr_business_trip_requests")
        .select("worker_name,start_date,end_date")
        .eq("company_id", input.companyId)
        .eq("id", input.requestId)
        .maybeSingle();
      await notifyApproverMobile({
        companyId: input.companyId,
        recipientUserId: next.data.approver_user_id,
        eventCode: "SITE_VISIT_APPROVAL_REQUIRED",
        title: "Business trip needs approval",
        body: `${request.data?.worker_name || "Team member"} requested a business trip (${request.data?.start_date ?? ""} – ${request.data?.end_date ?? ""}). Open Approval Inbox.`,
        route: "approvals",
        sourceKey: `${input.requestId}:${next.data.approver_user_id}`,
        data: { businessTripRequestId: input.requestId }
      });
    }
  }
  return {
    status,
    notice: status === "pending_hr"
      ? "Business trip approved and sent to HR for Present · Business trip finalization."
      : status === "pending_manager"
        ? "Approved and routed to the next reporting manager."
        : status === "rejected"
          ? "Business trip request rejected."
          : "Business trip decision saved."
  };
}

export async function listConnectBusinessTripHrApprovals(
  account: ConnectAccount,
  matchesReportee: (profileType: string, profileId: string | null) => boolean = () => true
) {
  const scope = await loadConnectAttendanceApproveScope(account);
  if (!scope.canFinalize) return [];
  const access = await loadConnectAccessibleWorkforceIds(account, scope);
  if (!access.allowAll && !(access.employeeIds?.size || access.contractorIds?.size)) return [];

  const result = await db().from("hr_business_trip_requests")
    .select("id,request_no,profile_type,profile_id,worker_code,worker_name,start_date,end_date,reason,manager_name,manager_note,manager_decided_at,requested_at,status")
    .eq("company_id", account.companyId)
    .eq("status", "pending_hr")
    .order("manager_decided_at");
  if (result.error) {
    if (/does not exist|schema cache/i.test(result.error.message)) return [];
    throw new Error(result.error.message);
  }

  return (result.data ?? []).flatMap((request) => {
    if (!connectWorkforceMatches(access, String(request.profile_type), String(request.profile_id))) return [];
    if (!matchesReportee(String(request.profile_type), request.profile_id as string | null)) return [];
    return [{
      id: request.id,
      requestId: request.id,
      requestNo: request.request_no,
      stepName: "HR finalization",
      stepOrder: 0,
      startDate: request.start_date,
      endDate: request.end_date,
      days: daysBetween(String(request.start_date), String(request.end_date)),
      reason: request.reason,
      requesterName: request.worker_name,
      requesterCode: request.worker_code ?? "",
      profileType: request.profile_type,
      managerName: request.manager_name,
      managerNote: request.manager_note,
      queue: "hr" as const
    }];
  });
}

export async function decideConnectBusinessTripHrApproval(input: {
  account: ConnectAccount;
  requestId: string;
  decision: "approved" | "returned" | "rejected";
  note?: string;
  defaultIn?: string;
  defaultOut?: string;
}) {
  const scope = await loadConnectAttendanceApproveScope(input.account);
  const actorUserId = scope.actorUserIds[0] ?? null;
  if (!actorUserId || !scope.canFinalize) {
    throw new Error("Business trip finalization is not enabled for this account.");
  }
  if (!/^[0-9a-f-]{36}$/i.test(input.requestId) || !["approved", "returned", "rejected"].includes(input.decision)) {
    throw new Error("Choose Apply Business Trip, Return, or Reject.");
  }
  if (input.decision !== "approved" && String(input.note ?? "").trim().length < 3) {
    throw new Error("Add a note when returning or rejecting business trip.");
  }
  const defaultIn = input.defaultIn ?? "09:00";
  const defaultOut = input.defaultOut ?? "18:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultIn) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultOut)) {
    throw new Error("Choose valid fallback IN and OUT times.");
  }

  const access = await loadConnectAccessibleWorkforceIds(input.account, scope);
  const existing = await db().from("hr_business_trip_requests")
    .select("id,profile_type,profile_id,status")
    .eq("company_id", input.account.companyId)
    .eq("id", input.requestId)
    .maybeSingle();
  if (existing.error || !existing.data) throw new Error(existing.error?.message ?? "Business trip request was not found.");
  if (String(existing.data.status) !== "pending_hr") {
    throw new Error("This business trip request is no longer awaiting HR finalization.");
  }
  if (!connectWorkforceMatches(access, String(existing.data.profile_type), String(existing.data.profile_id))) {
    throw new Error("This business trip request is outside your attendance scope.");
  }

  const result = await db().rpc("hr_finalize_business_trip_request", {
    p_company_id: input.account.companyId,
    p_request_id: input.requestId,
    p_actor_user_id: actorUserId,
    p_decision: input.decision,
    p_note: input.note ?? null,
    p_reviewer_name: input.account.name ?? input.account.reference ?? "HR reviewer",
    p_default_in: defaultIn,
    p_default_out: defaultOut
  });
  if (result.error) throw new Error(result.error.message);
  const payload = result.data as { appliedDates?: string[]; skippedDates?: unknown[] } | null;
  if (input.decision === "approved") {
    return {
      notice: `Business trip approved: ${payload?.appliedDates?.length ?? 0} working day(s) marked Present · Business trip; ${payload?.skippedDates?.length ?? 0} date(s) skipped.`
    };
  }
  return { notice: `Business trip request ${input.decision}.` };
}

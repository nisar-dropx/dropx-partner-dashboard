import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import {
  activeExpenseCategories,
  connectApproverIdentity,
  expenseCategoriesForPolicy,
  expenseIdentity,
  expensePayoutReadiness,
  expenseWorkerType,
  resolveExpenseApprovers,
  resolveExpenseClaimRequestAssignees
} from "../../../../src/lib/connect-expense-data";
import { notifyExpenseUser } from "../../../../src/lib/connect-expense-notifications";
import { loadConnectReporteeAccess, normalizeConnectReporteeScope } from "../../../../src/lib/connect-reportee-scope";
import { mergeExpenseReceiptsToPdf } from "../../../../src/lib/merge-expense-receipts";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }
function clean(value: unknown) { return String(value ?? "").trim(); }
function safeFileName(value: string) { return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "receipt"; }
function relation<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }

async function signedAttachments(value: Array<{ id: string; item_id: string | null; file_name: string; content_type: string | null; storage_path: string }> | null | undefined) {
  return Promise.all((value ?? []).map(async (attachment) => {
    const signed = await db().storage.from("hr-expense-receipts").createSignedUrl(attachment.storage_path, 15 * 60);
    return { id: attachment.id, item_id: attachment.item_id, file_name: attachment.file_name, content_type: attachment.content_type, url: signed.data?.signedUrl ?? null };
  }));
}

async function selectedAccount(request: Request, body?: Record<string, unknown>, approverAccess = false) {
  const url = new URL(request.url);
  const accountId = clean(body?.accountId ?? url.searchParams.get("accountId"));
  const profileType = clean(body?.profileType ?? url.searchParams.get("profileType"));
  if (!accountId || !profileType || (!expenseWorkerType(profileType) && !(approverAccess && profileType === "user"))) {
    throw new Error(approverAccess ? "Select an authorised approver account." : "Select an employee or independent contractor account.");
  }
  return requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
}

async function approvalPayload(companyId: string, userId: string | null) {
  if (!userId) return [];
  const result = await db().from("hr_expense_approval_steps")
    .select("id,claim_id,step_order,step_name,status,hr_expense_claims(id,claim_no,purpose,total_claimed,trip_from,trip_to,status,employee_id,contractor_id,employees(full_name,employee_code),contractors(full_name,dropx_id),hr_expense_items(id,expense_date,merchant,description,amount,hr_expense_categories(id,name,code)),hr_expense_attachments(id,item_id,file_name,content_type,storage_path))")
    .eq("company_id", companyId).eq("approver_user_id", userId).eq("status", "pending").order("created_at");
  if (result.error) throw new Error(result.error.message);
  // Claim steps are assigned explicitly (RM / finance head). Do not require org-chart reportee scope —
  // finance L2 is often outside the claimant's reporting tree.
  return Promise.all((result.data ?? []).flatMap((step) => {
    const claim = relation(step.hr_expense_claims);
    if (!claim) return [];
    const employee = relation(claim.employees);
    const contractor = relation(claim.contractors);
    return [(async () => ({
      kind: "claim" as const,
      ...step,
      claim: {
        ...claim,
        requesterName: employee?.full_name ?? contractor?.full_name ?? "Team member",
        requesterCode: employee?.employee_code ?? contractor?.dropx_id ?? "",
        attachments: await signedAttachments(claim.hr_expense_attachments)
      }
    }))()];
  }));
}

async function preRequestApprovalPayload(companyId: string, userId: string | null) {
  if (!userId) return [];
  const result = await db().from("hr_expense_claim_request_assignees")
    .select("id,request_id,assignee_role,status,hr_expense_claim_requests(id,request_no,purpose,estimated_amount,trip_from,trip_to,notes,status,created_at,employee_id,contractor_id,employees(full_name,employee_code),contractors(full_name,dropx_id))")
    .eq("company_id", companyId).eq("approver_user_id", userId).eq("status", "pending").order("created_at");
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).flatMap((row) => {
    const request = relation(row.hr_expense_claim_requests);
    if (!request || request.status !== "pending") return [];
    const employee = relation(request.employees);
    const contractor = relation(request.contractors);
    return [{
      kind: "pre_request" as const,
      id: row.id,
      request_id: row.request_id,
      assignee_role: row.assignee_role,
      status: row.status,
      request: {
        ...request,
        requesterName: employee?.full_name ?? contractor?.full_name ?? "Team member",
        requesterCode: employee?.employee_code ?? contractor?.dropx_id ?? ""
      }
    }];
  });
}

async function claimPayload(account: ConnectAccount) {
  const identity = await expenseIdentity(account);
  const workerColumn = identity.workerType === "employee" ? "employee_id" : "contractor_id";
  const [categories, payout, claimsResult, requestsResult] = await Promise.all([
    activeExpenseCategories(account),
    expensePayoutReadiness(account),
    db().from("hr_expense_claims")
      .select("id,claim_no,claim_request_id,purpose,trip_from,trip_to,total_claimed,total_approved,status,current_step,submitted_at,created_at,return_reason,rejection_reason,payment_request_id,hr_expense_items(id,expense_date,merchant,description,amount,approved_amount,reviewer_note,hr_expense_categories(id,name,code)),hr_expense_attachments(id,item_id,file_name,content_type,storage_path),hr_expense_approval_steps(id,step_order,step_name,approver_user_id,status,decision_note,decided_by,decided_at),hr_expense_events(id,event_type,from_status,to_status,actor_name,actor_role,comments,metadata,created_at),payment_requests(request_no,status,approval_status,utr_cin,bank_status,bank_processing_remarks,processing_started_at,processed_at)")
      .eq("company_id", account.companyId).eq(workerColumn, account.id).order("created_at", { ascending: false }).limit(50),
    db().from("hr_expense_claim_requests")
      .select("id,request_no,purpose,estimated_amount,trip_from,trip_to,notes,status,decision_note,decided_at,consumed_claim_id,created_at,hr_expense_claim_request_assignees(id,assignee_role,approver_user_id,status,decision_note,decided_at)")
      .eq("company_id", account.companyId).eq(workerColumn, account.id).order("created_at", { ascending: false }).limit(50)
  ]);
  if (claimsResult.error) throw new Error(claimsResult.error.message ?? "Unable to load reimbursements.");
  if (requestsResult.error) throw new Error(requestsResult.error.message ?? "Unable to load reimbursement requests.");
  const stepUserIds = [...new Set((claimsResult.data ?? []).flatMap((claim) =>
    (claim.hr_expense_approval_steps ?? []).map((step) => step.approver_user_id).filter(Boolean)
  ))];
  const assigneeUserIds = [...new Set((requestsResult.data ?? []).flatMap((request) =>
    (request.hr_expense_claim_request_assignees ?? []).map((assignee) => assignee.approver_user_id).filter(Boolean)
  ))];
  const profileIds = [...new Set([...stepUserIds, ...assigneeUserIds])];
  const profiles = profileIds.length
    ? await db().from("profiles").select("id,full_name").eq("company_id", account.companyId).in("id", profileIds)
    : { data: [], error: null };
  if (profiles.error) throw new Error(profiles.error.message);
  const nameByUserId = new Map((profiles.data ?? []).map((profile) => [profile.id, profile.full_name ?? "Approver"]));
  const claims = await Promise.all((claimsResult.data ?? []).map(async (claim) => ({
    ...claim,
    payment: relation(claim.payment_requests),
    items: claim.hr_expense_items,
    steps: [...(claim.hr_expense_approval_steps ?? [])]
      .sort((a, b) => a.step_order - b.step_order)
      .map((step) => ({
        ...step,
        approver_name: nameByUserId.get(step.approver_user_id) ?? "Approver"
      })),
    events: [...(claim.hr_expense_events ?? [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    attachments: await signedAttachments(claim.hr_expense_attachments)
  })));
  const preRequests = (requestsResult.data ?? []).map((request) => ({
    ...request,
    assignees: (request.hr_expense_claim_request_assignees ?? []).map((assignee) => ({
      ...assignee,
      approver_name: nameByUserId.get(assignee.approver_user_id) ?? "Approver"
    }))
  }));
  const [approvals, preRequestApprovals] = await Promise.all([
    approvalPayload(account.companyId, identity.userId),
    preRequestApprovalPayload(account.companyId, identity.userId)
  ]);
  return { categories, payout, claims, preRequests, approvals, preRequestApprovals };
}

export async function GET(request: Request) {
  try {
    const account = await selectedAccount(request, undefined, true);
    const scope = normalizeConnectReporteeScope(new URL(request.url).searchParams.get("reporteeScope"));
    const reportees = await loadConnectReporteeAccess(account, scope);
    if (account.profileType === "user") {
      const [approvals, preRequestApprovals] = await Promise.all([
        approvalPayload(account.companyId, account.id),
        preRequestApprovalPayload(account.companyId, account.id)
      ]);
      return NextResponse.json({
        categories: [],
        payout: { ready: false, message: null },
        claims: [],
        preRequests: [],
        approvals,
        preRequestApprovals,
        scope
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const payload = await claimPayload(account);
    return NextResponse.json({ ...payload, scope }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load reimbursements." }, { status: 400 });
  }
}

type InputItem = { id: string; categoryId: string; expenseDate: string; merchant: string; description: string; amount: number };

async function submitPreRequest(form: FormData, account: ConnectAccount) {
  const purpose = clean(form.get("purpose"));
  const notes = clean(form.get("notes"));
  const tripFrom = clean(form.get("tripFrom")) || null;
  const tripTo = clean(form.get("tripTo")) || null;
  const estimatedRaw = clean(form.get("estimatedAmount"));
  const estimatedAmount = estimatedRaw ? Number(estimatedRaw) : null;
  if (purpose.length < 3 || purpose.length > 500) throw new Error("Enter a purpose between 3 and 500 characters.");
  if (tripFrom && tripTo && tripTo < tripFrom) throw new Error("Trip end date cannot be before its start date.");
  if (estimatedAmount != null && (!Number.isFinite(estimatedAmount) || estimatedAmount < 0)) throw new Error("Enter a valid estimated amount.");
  if (notes.length > 1000) throw new Error("Notes must be 1000 characters or fewer.");

  const { identity, assignees } = await resolveExpenseClaimRequestAssignees(account);
  const requestId = randomUUID();
  const rpc = await db().rpc("hr_submit_expense_claim_request", {
    p_company_id: account.companyId,
    p_request_id: requestId,
    p_worker_type: identity.workerType,
    p_worker_id: identity.workerId,
    p_claimant_person_id: identity.personId,
    p_claimant_user_id: identity.userId,
    p_assignment_id: identity.assignment.id,
    p_location_id: identity.assignment.location_id,
    p_designation_id: identity.assignment.designation_id,
    p_purpose: purpose,
    p_estimated_amount: estimatedAmount,
    p_trip_from: tripFrom,
    p_trip_to: tripTo,
    p_notes: notes || null,
    p_assignees: assignees
  });
  if (rpc.error) throw new Error(rpc.error.message);

  const estimateLabel = estimatedAmount != null ? `Rs ${estimatedAmount.toLocaleString("en-IN")}` : "an estimated amount";
  await Promise.all(assignees.map((assignee) => notifyExpenseUser({
    companyId: account.companyId,
    claimRequestId: requestId,
    recipientUserId: assignee.approver_user_id,
    eventCode: "REIMBURSEMENT_REQUEST_APPROVAL_REQUIRED",
    title: "Reimbursement request needs approval",
    body: `${account.name ?? "A team member"} requested approval to claim ${estimateLabel} for ${purpose}.`,
    emailSubject: `Reimbursement request · ${account.name ?? "Team member"}`,
    emailBody: `${account.name ?? "A team member"} requested permission to submit a reimbursement for ${purpose}${estimatedAmount != null ? ` (estimate Rs ${estimatedAmount.toLocaleString("en-IN")})` : ""}. Open DropX One or People Approval Inbox to approve or reject.`,
    route: "approvals"
  })));

  return NextResponse.json({
    ok: true,
    requestId,
    notice: "Request submitted. Your reporting manager or finance head can approve it."
  });
}

async function submitClaim(form: FormData, account: ConnectAccount) {
  const uploadedPaths: string[] = [];
  let priorPaths: string[] = [];
  let claimId = "";
  let isResubmit = false;
  try {
    const payout = await expensePayoutReadiness(account);
    if (!payout.ready) throw new Error(payout.message ?? "Complete your payout details before submitting.");
    const existingClaimId = clean(form.get("claimId"));
    isResubmit = Boolean(existingClaimId);
    const claimRequestId = clean(form.get("claimRequestId"));
    const purpose = clean(form.get("purpose"));
    const tripFrom = clean(form.get("tripFrom")) || null;
    const tripTo = clean(form.get("tripTo")) || null;
    const rawItems = JSON.parse(clean(form.get("items")) || "[]") as Array<Record<string, unknown>>;
    if (!isResubmit && !claimRequestId) throw new Error("Select an approved reimbursement request before submitting a claim.");
    if (purpose.length < 3 || purpose.length > 500) throw new Error("Enter a purpose between 3 and 500 characters.");
    if (tripFrom && tripTo && tripTo < tripFrom) throw new Error("Trip end date cannot be before its start date.");
    if (!rawItems.length || rawItems.length > 50) throw new Error("Add between 1 and 50 expense lines.");
    const items: InputItem[] = rawItems.map((item) => ({
      id: clean(item.id) || randomUUID(),
      categoryId: clean(item.categoryId),
      expenseDate: clean(item.expenseDate),
      merchant: clean(item.merchant).slice(0, 160),
      description: clean(item.description).slice(0, 500),
      amount: Number(item.amount)
    }));

    const receiptFiles: File[] = [];
    for (const entry of form.getAll("receipts")) {
      if (entry instanceof File && entry.size > 0) receiptFiles.push(entry);
    }
    for (const item of items) {
      const legacy = form.get(`receipt:${item.id}`);
      if (legacy instanceof File && legacy.size > 0) receiptFiles.push(legacy);
    }
    if (!receiptFiles.length) throw new Error("Attach at least one receipt image or PDF.");
    for (const receipt of receiptFiles) {
      if (receipt.size > 10 * 1024 * 1024) throw new Error("Each receipt must be 10 MB or smaller.");
      if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(receipt.type)) {
        throw new Error("Receipts must be PDF, JPG, PNG or WebP.");
      }
    }

    for (const item of items) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.expenseDate)) throw new Error("Every expense line needs a valid date.");
      if (item.description.length < 3) throw new Error("Every expense line needs a description.");
      if (!Number.isFinite(item.amount) || item.amount <= 0) throw new Error("Every expense line needs a valid positive amount.");
    }

    const total = items.reduce((sum, item) => sum + item.amount, 0);
    const approval = await resolveExpenseApprovers(account, total);
    const categories = await expenseCategoriesForPolicy(account, approval.policy.id);
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const dailyTotals = new Map<string, number>();
    for (const item of items) {
      const category = categoryById.get(item.categoryId);
      if (!category) throw new Error("This expense category is not allowed by the matching reimbursement policy.");
      if (category.per_item_limit != null && item.amount > Number(category.per_item_limit)) throw new Error(`${category.name} exceeds the configured per-item limit.`);
      const dayKey = `${item.categoryId}:${item.expenseDate}`;
      dailyTotals.set(dayKey, (dailyTotals.get(dayKey) ?? 0) + item.amount);
      if (category.per_day_limit != null && Number(dailyTotals.get(dayKey)) > Number(category.per_day_limit)) throw new Error(`${category.name} exceeds the configured daily limit.`);
      const receiptNeeded = category.receipt_required && item.amount >= Number(category.receipt_threshold ?? 0);
      if (receiptNeeded && !receiptFiles.length) throw new Error(`Receipt is required for ${category.name}.`);
    }

    claimId = existingClaimId || randomUUID();
    let linkedRequestId = claimRequestId;
    if (isResubmit) {
      const workerColumn = approval.identity.workerType === "employee" ? "employee_id" : "contractor_id";
      const [claim, attachments] = await Promise.all([
        db().from("hr_expense_claims").select(`id,status,claim_request_id,${workerColumn}`).eq("company_id", account.companyId).eq("id", claimId).eq(workerColumn, account.id).maybeSingle(),
        db().from("hr_expense_attachments").select("storage_path").eq("company_id", account.companyId).eq("claim_id", claimId)
      ]);
      if (claim.error || !claim.data || claim.data.status !== "returned") throw new Error(claim.error?.message ?? "Only your returned reimbursement can be resubmitted.");
      if (attachments.error) throw new Error(attachments.error.message);
      priorPaths = (attachments.data ?? []).map((item) => item.storage_path);
      linkedRequestId = claim.data.claim_request_id ?? linkedRequestId;
    } else {
      const workerColumn = approval.identity.workerType === "employee" ? "employee_id" : "contractor_id";
      const request = await db().from("hr_expense_claim_requests")
        .select("id,status,consumed_claim_id,purpose,trip_from,trip_to")
        .eq("company_id", account.companyId)
        .eq("id", linkedRequestId)
        .eq(workerColumn, account.id)
        .maybeSingle();
      if (request.error || !request.data) throw new Error(request.error?.message ?? "Approved reimbursement request was not found.");
      if (request.data.status !== "approved") throw new Error("Only an approved reimbursement request can be claimed.");
      if (request.data.consumed_claim_id) throw new Error("This request already has a claim.");
    }

    const mergeInputs = await Promise.all(receiptFiles.map(async (file) => ({
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      contentType: file.type || "application/octet-stream"
    })));
    const mergedPdf = await mergeExpenseReceiptsToPdf(mergeInputs);
    const mergedPath = `${account.companyId}/${claimId}/merged/${Date.now()}-receipts.pdf`;
    const upload = await db().storage.from("hr-expense-receipts").upload(mergedPath, mergedPdf, {
      contentType: "application/pdf",
      upsert: false
    });
    if (upload.error) throw new Error(`Receipt upload failed: ${upload.error.message}`);
    uploadedPaths.push(mergedPath);

    const commonRpc = {
      p_company_id: account.companyId,
      p_claim_id: claimId,
      p_worker_type: approval.identity.workerType,
      p_worker_id: approval.identity.workerId,
      p_policy_id: approval.policy.id,
      p_payment_head_id: approval.policy.payment_head_id,
      p_purpose: purpose,
      p_trip_from: tripFrom,
      p_trip_to: tripTo,
      p_items: items.map((item, index) => ({
        id: item.id,
        category_id: item.categoryId,
        expense_date: item.expenseDate,
        merchant: item.merchant,
        description: item.description,
        amount: item.amount,
        sort_order: (index + 1) * 10
      })),
      p_steps: approval.steps
    };
    const rpc = isResubmit
      ? await db().rpc("hr_resubmit_expense_claim", { ...commonRpc, p_actor_user_id: approval.identity.userId })
      : await db().rpc("hr_submit_expense_claim", {
        ...commonRpc,
        p_claimant_person_id: approval.identity.personId,
        p_claimant_user_id: approval.identity.userId,
        p_assignment_id: approval.identity.assignment.id,
        p_location_id: approval.identity.assignment.location_id,
        p_designation_id: approval.identity.assignment.designation_id,
        p_claim_request_id: linkedRequestId
      });
    if (rpc.error) throw new Error(rpc.error.message);

    if (isResubmit) {
      await db().from("hr_expense_attachments").delete().eq("company_id", account.companyId).eq("claim_id", claimId);
    }
    const attachmentResult = await db().from("hr_expense_attachments").insert({
      company_id: account.companyId,
      claim_id: claimId,
      item_id: null,
      storage_path: mergedPath,
      file_name: "receipts.pdf",
      content_type: "application/pdf",
      file_size: mergedPdf.byteLength,
      uploaded_by: approval.identity.userId
    });
    if (attachmentResult.error) throw new Error(attachmentResult.error.message);
    if (isResubmit && priorPaths.length) await db().storage.from("hr-expense-receipts").remove(priorPaths);

    const firstApprover = approval.steps[0];
    const notification = await notifyExpenseUser({
      companyId: account.companyId,
      claimId,
      recipientUserId: firstApprover.approver_user_id,
      eventCode: "REIMBURSEMENT_APPROVAL_REQUIRED",
      title: "Reimbursement needs approval",
      body: `${account.name ?? "A team member"} submitted Rs ${total.toLocaleString("en-IN")} for ${purpose}.`,
      emailSubject: `Reimbursement approval required · ${account.name ?? "Team member"}`,
      emailBody: `${account.name ?? "A team member"} submitted a reimbursement claim for Rs ${total.toLocaleString("en-IN")} (${purpose}). Open DropX One or People Approval Inbox to review it.`,
      route: "approvals"
    });
    return NextResponse.json({
      ok: true,
      claimId,
      notice: `Claim ${isResubmit ? "resubmitted" : "submitted"} through ${approval.policy.name}.${notification.status === "failed" ? ` Email warning: ${notification.error}` : ""}`
    });
  } catch (error) {
    if (account && claimId && !isResubmit) await db().from("hr_expense_claims").delete().eq("company_id", account.companyId).eq("id", claimId);
    if (uploadedPaths.length) await db().storage.from("hr-expense-receipts").remove(uploadedPaths);
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const account = await selectedAccount(request, { accountId: form.get("accountId"), profileType: form.get("profileType") });
    const kind = clean(form.get("kind")).toLowerCase() || "claim";
    if (kind === "pre_request") return await submitPreRequest(form, account);
    return await submitClaim(form, account);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit reimbursement." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const kind = clean(body.kind).toLowerCase() || "claim";
    const action = clean(body.action).toLowerCase();
    const note = clean(body.note);

    if (kind === "pre_request" && action === "withdrawn") {
      const account = await selectedAccount(request, body, false);
      const identity = await expenseIdentity(account);
      if (!identity.userId) throw new Error("Your One account is not linked to a People login.");
      const requestId = clean(body.requestId);
      if (!requestId) throw new Error("Select the reimbursement request to withdraw.");
      const result = await db().rpc("hr_withdraw_expense_claim_request", {
        p_company_id: account.companyId,
        p_request_id: requestId,
        p_actor_user_id: identity.userId,
        p_note: note || null
      });
      if (result.error) throw new Error(result.error.message);
      return NextResponse.json({ ok: true, notice: "Reimbursement request withdrawn." });
    }

    const account = await selectedAccount(request, body, true);
    const identity = account.profileType === "user" ? null : await connectApproverIdentity(account);
    const approverUserId = account.profileType === "user" ? account.id : identity?.userId;
    if (!approverUserId) throw new Error("Your One account is not linked to a People approver login.");

    if (kind === "pre_request") {
      const requestId = clean(body.requestId);
      if (!requestId || !["approved", "rejected"].includes(action)) throw new Error("Select a valid reimbursement request decision.");
      const result = await db().rpc("hr_decide_expense_claim_request", {
        p_company_id: account.companyId,
        p_request_id: requestId,
        p_actor_user_id: approverUserId,
        p_action: action,
        p_note: note || null
      });
      if (result.error) throw new Error(result.error.message);
      const requestRow = await db().from("hr_expense_claim_requests")
        .select("request_no,purpose,estimated_amount,claimant_user_id")
        .eq("company_id", account.companyId)
        .eq("id", requestId)
        .single();
      if (requestRow.error) throw new Error(requestRow.error.message);
      await notifyExpenseUser({
        companyId: account.companyId,
        claimRequestId: requestId,
        recipientUserId: requestRow.data.claimant_user_id,
        eventCode: `REIMBURSEMENT_REQUEST_${action.toUpperCase()}`,
        title: action === "approved" ? "Reimbursement request approved" : "Reimbursement request rejected",
        body: action === "approved"
          ? `${requestRow.data.request_no} is approved. You can now submit your reimbursement claim.`
          : `${requestRow.data.request_no} was rejected.${note ? ` ${note}` : ""}`,
        emailSubject: `Reimbursement request ${action} · ${requestRow.data.request_no}`,
        emailBody: action === "approved"
          ? `${requestRow.data.request_no} for ${requestRow.data.purpose} is approved. Open DropX One Reimbursements to submit your claim with receipts.`
          : `${requestRow.data.request_no} was rejected.${note ? `\n\nReason: ${note}` : ""}`,
        route: "reimbursements"
      });
      return NextResponse.json({ ok: true, notice: `Request ${action}.` });
    }

    const claimId = clean(body.claimId);
    if (!claimId || !["approved", "returned", "rejected"].includes(action)) throw new Error("Select a valid reimbursement decision.");
    const result = await db().rpc("hr_decide_expense_claim", { p_company_id: account.companyId, p_claim_id: claimId, p_actor_user_id: approverUserId, p_action: action, p_note: note || null });
    if (result.error) throw new Error(result.error.message);
    const decision = Array.isArray(result.data) ? result.data[0] : result.data;
    const claim = await db().from("hr_expense_claims").select("claim_no,purpose,total_claimed,claimant_user_id").eq("company_id", account.companyId).eq("id", claimId).single();
    if (claim.error) throw new Error(claim.error.message);
    const nextUserId = decision?.next_approver_user_id ?? null;
    if (nextUserId) {
      await notifyExpenseUser({ companyId: account.companyId, claimId, recipientUserId: nextUserId, eventCode: "REIMBURSEMENT_APPROVAL_REQUIRED", title: "Reimbursement needs approval", body: `${claim.data.claim_no} is waiting for your approval.`, emailSubject: `Reimbursement approval required · ${claim.data.claim_no}`, emailBody: `${claim.data.claim_no} for Rs ${Number(claim.data.total_claimed).toLocaleString("en-IN")} is waiting for your approval. Open DropX One or People Approval Inbox.`, route: "approvals" });
    }
    await notifyExpenseUser({ companyId: account.companyId, claimId, recipientUserId: claim.data.claimant_user_id, eventCode: `REIMBURSEMENT_${action.toUpperCase()}`, title: action === "approved" ? "Reimbursement updated" : `Reimbursement ${action}`, body: nextUserId ? `${claim.data.claim_no} was approved and moved to the next approver.` : decision?.claim_status === "approved_for_payment" ? `${claim.data.claim_no} is approved and sent to Payments.` : `${claim.data.claim_no} was ${action}.${note ? ` ${note}` : ""}`, emailSubject: `Reimbursement ${action} · ${claim.data.claim_no}`, emailBody: nextUserId ? `${claim.data.claim_no} was approved and has moved to the next approver.` : decision?.claim_status === "approved_for_payment" ? `${claim.data.claim_no} is fully approved and has been sent to Payments. You can track processing and UTR in DropX One.` : `${claim.data.claim_no} was ${action}.${note ? `\n\nReason: ${note}` : ""}` });
    return NextResponse.json({ ok: true, notice: decision?.claim_status === "approved_for_payment" ? "Approved and sent to Payments." : `Claim ${action}.` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update reimbursement." }, { status: 400 });
  }
}

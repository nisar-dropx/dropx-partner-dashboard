import { NextResponse } from "next/server";

import { approvePaymentRequest, rejectPaymentRequest, returnPaymentRequest } from "@/app/payments/approvals/actions";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canOverseePayment } from "@/lib/payment-oversight-policy";
import { getPaymentApprovalActionEligibility, getPaymentApprovalEligibility } from "@/lib/payment-approval-scope";
import { paymentRequestAttachments } from "@/lib/payment-request-attachments";
import { isPaymentTrackingQuestion, parsePaymentTrackingIds, paymentShipmentCount } from "@/lib/payment-shipment-count";
import { adhocApprovalContext } from "@/lib/payment-volume";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function jsonError(error: unknown, fallback: string, status = 400) {
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

async function authorizedRequest(requestId: string, requireEdit = false) {
  const authorization = await getAuthorization();
  if (!authorization) return { error: NextResponse.json({ error: "Login required." }, { status: 401 }) } as const;
  const action = requireEdit ? "edit" : "access";
  if (!hasPermission(authorization, "payment_approvals", action)) {
    return { error: NextResponse.json({ error: "Payment approval access denied." }, { status: 403 }) } as const;
  }
  if (!supabaseAdmin) return { error: NextResponse.json({ error: "Database configuration is unavailable." }, { status: 503 }) } as const;

  const companyId = requireCompanyId(authorization);
  const result = await supabaseAdmin
    .from("payment_requests")
    .select("id,request_no,location_id,location_code,payment_head_id,requested_by,status,approval_status,current_approver_user_id,current_approver_role_id,current_approver_role_ids,current_step_order,total_steps,adhoc_vehicle_snapshot,adhoc_reason_key,adhoc_deployment_date,stations(location_model_id),payment_heads(name,code)")
    .eq("company_id", companyId)
    .eq("id", requestId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return { error: NextResponse.json({ error: "Payment request not found." }, { status: 404 }) } as const;

  const station = relation(result.data.stations);
  const request = { ...result.data, location_model_id: station?.location_model_id ?? null };
  const eligible = requireEdit
    ? await getPaymentApprovalActionEligibility(companyId, authorization, [request])
    : await getPaymentApprovalEligibility(companyId, authorization, [request]);
  if (!eligible.has(request.id) && (requireEdit || !canOverseePayment(authorization, request))) {
    return { error: NextResponse.json({ error: "This payment request is outside your approval scope." }, { status: 403 }) } as const;
  }
  return { authorization, companyId, request } as const;
}

export async function GET(_request: Request, context: { params: { requestId: string } }) {
  try {
    const access = await authorizedRequest(context.params.requestId);
    if ("error" in access) return access.error;
    const { companyId, request } = access;

    const [stationResult, answersResult, logsResult] = await Promise.all([
      supabaseAdmin!
        .from("stations")
        .select("station_code,station_name,city")
        .eq("company_id", companyId)
        .eq(request.location_id ? "id" : "station_code", request.location_id || request.location_code)
        .maybeSingle(),
      supabaseAdmin!
        .from("payment_request_answers")
        .select("id,answer_value,file_path,file_name,file_size,attachments,payment_head_questions(question_text,answer_type)")
        .eq("company_id", companyId)
        .eq("payment_request_id", request.id),
      supabaseAdmin!
        .from("payment_request_approvals")
        .select("id,action,comments,created_at,approver_user_id,approver_role_id")
        .eq("company_id", companyId)
        .eq("payment_request_id", request.id)
        .order("created_at", { ascending: true })
    ]);
    if (stationResult.error || answersResult.error || logsResult.error) {
      throw new Error(stationResult.error?.message || answersResult.error?.message || logsResult.error?.message || "Unable to load request details.");
    }

    const rawAnswers = answersResult.data ?? [];
    const normalizedAnswers = rawAnswers.map((answer) => {
      const question = relation(answer.payment_head_questions);
      return {
        ...answer,
        payment_head_questions: question ? {
          answer_type: question.answer_type,
          question_text: question.question_text
        } : null
      };
    });
    const userIds = [...new Set((logsResult.data ?? []).map((row) => row.approver_user_id).filter((id): id is string => Boolean(id)))];
    const roleIds = [...new Set((logsResult.data ?? []).map((row) => row.approver_role_id).filter((id): id is string => Boolean(id)))];
    const [profilesResult, rolesResult] = await Promise.all([
      userIds.length ? supabaseAdmin!.from("profiles").select("id,full_name,email").eq("company_id", companyId).in("id", userIds) : Promise.resolve({ data: [], error: null }),
      roleIds.length ? supabaseAdmin!.from("user_roles").select("id,name,code").eq("company_id", companyId).in("id", roleIds) : Promise.resolve({ data: [], error: null })
    ]);
    const names = new Map((profilesResult.data ?? []).map((row) => [row.id, row.full_name || row.email || "User"]));
    const roles = new Map((rolesResult.data ?? []).map((row) => [row.id, row.name || row.code || "-"]));
    const stationName = stationResult.data?.station_name || stationResult.data?.city || "";
    const locationLabel = `${request.location_code}${stationName ? ` - ${stationName}` : ""}`;
    const answers = normalizedAnswers.map((answer) => {
      const question = answer.payment_head_questions;
      return {
        answerType: question?.answer_type ?? null,
        answerValue: answer.answer_value,
        attachments: paymentRequestAttachments(answer).map((file, index) => ({
          name: file.name,
          size: file.size,
          url: `/api/payments/requests/attachment?answer_id=${encodeURIComponent(answer.id)}&attachment_index=${index}`
        })),
        id: answer.id,
        questionText: question?.question_text || "Field"
      };
    });
    const trackingCount = new Set(normalizedAnswers
      .filter((answer) => isPaymentTrackingQuestion(answer.payment_head_questions))
      .flatMap((answer) => parsePaymentTrackingIds(answer.answer_value ?? ""))).size;
    const head = relation(request.payment_heads);

    return NextResponse.json({
      answers,
      attachmentCount: answers.reduce((count, answer) => count + answer.attachments.length, 0),
      locationLabel,
      logs: (logsResult.data ?? []).map((row) => ({
        action: row.action,
        actor: row.approver_user_id ? names.get(row.approver_user_id) ?? "User" : "System",
        comments: row.comments,
        createdAt: row.created_at,
        id: row.id,
        role: row.approver_role_id ? roles.get(row.approver_role_id) ?? "-" : "-"
      })),
      replacement: request.adhoc_vehicle_snapshot ?? null,
      shipmentCount: paymentShipmentCount(normalizedAnswers),
      trackingCount,
      volumeDate: adhocApprovalContext(head?.code, normalizedAnswers)
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error, "Unable to load payment request details.", 500);
  }
}

export async function PATCH(request: Request, context: { params: { requestId: string } }) {
  try {
    const access = await authorizedRequest(context.params.requestId, true);
    if ("error" in access) return access.error;
    const body = await request.json() as { action?: unknown; comments?: unknown };
    const action = String(body.action ?? "").trim().toLowerCase();
    const comments = String(body.comments ?? "").trim();
    if (!['approve', 'return', 'reject'].includes(action)) {
      return NextResponse.json({ error: "Choose approve, return, or reject." }, { status: 400 });
    }
    if ((action === "return" || action === "reject") && !comments) {
      return NextResponse.json({ error: `${action === "return" ? "Return" : "Reject"} remarks are required.` }, { status: 400 });
    }
    const form = new FormData();
    form.set("request_id", context.params.requestId);
    form.set("comments", comments);
    if (action === "approve") await approvePaymentRequest(form);
    if (action === "return") await returnPaymentRequest(form);
    if (action === "reject") await rejectPaymentRequest(form);
    return NextResponse.json({ ok: true, notice: `Payment request ${action === "approve" ? "approved" : action === "return" ? "returned" : "rejected"}.` });
  } catch (error) {
    return jsonError(error, "Unable to update payment request.");
  }
}

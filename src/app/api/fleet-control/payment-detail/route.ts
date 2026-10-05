import {loadPaymentVolume,paymentVolumeToday} from '@/lib/payment-volume-data';
import {adhocApprovalContext} from '@/lib/payment-volume';
import {estimatedShipments} from '@/lib/expense-variance';
import { NextResponse, type NextRequest } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership } from "@/lib/fleet-control";
import { isFleetManagerPaymentRequest } from "@/lib/fleet-control-payment-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

export async function GET(request: NextRequest) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!supabaseAdmin) return NextResponse.json({ error: "Fleet payment detail is temporarily unavailable." }, { status: 503 });

    const companyId = requireCompanyId(authorization);
    const canReadPayments = hasPermission(authorization, "payment_approvals", "access") || hasPermission(authorization, "payment_requests", "access");
    const hasMembership = authorization.isMasterOwner || await hasActiveFleetMembership(companyId, authorization.userId);
    const hasFleetAccess = hasMembership && (canReadPayments || hasPermission(authorization, "fleet_action_center", "access") || hasPermission(authorization, "fleet_vehicle_view", "access"));
    if (!hasFleetAccess) return NextResponse.json({ error: "Fleet payment access denied." }, { status: 403 });

    const requestId = request.nextUrl.searchParams.get("requestId")?.trim();
    if (!requestId) return NextResponse.json({ error: "Payment request is required." }, { status: 400 });

    const paymentResult = await supabaseAdmin
      .from("payment_requests")
      .select("adhoc_reason_key,adhoc_vehicle_snapshot,adhoc_deployment_date,location_code,amount_requested,amount,id,request_no,location_id,payment_head_id,requested_by,remarks,status,approval_status,current_approver_user_id,current_approver_role_id,current_approver_role_ids,created_at,processed_at")
      .eq("company_id", companyId)
      .eq("id", requestId)
      .maybeSingle();
    if (paymentResult.error) throw new Error(paymentResult.error.message);
    const payment = paymentResult.data as any;
    if (!payment) return NextResponse.json({ error: "Payment request was not found." }, { status: 404 });
    if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner && (!payment.location_id || !authorization.locationScopeIds.includes(payment.location_id))) {
      return NextResponse.json({ error: "This payment is outside your permitted vehicle placements." }, { status: 403 });
    }

    const headResult = await supabaseAdmin.from("payment_heads").select("id,code,name").eq("company_id", companyId).eq("id", payment.payment_head_id).maybeSingle();
    if (headResult.error) throw new Error(headResult.error.message);
    if (!headResult.data || !isFleetManagerPaymentRequest(headResult.data,payment.adhoc_reason_key)) {
      return NextResponse.json({ error: "This request is not owned by Fleet." }, { status: 403 });
    }

    const [answersResult, logsResult] = await Promise.all([
      supabaseAdmin
        .from("payment_request_answers")
        .select("id,answer_value,file_path,file_name,payment_head_questions(question_text,answer_type)")
        .eq("company_id", companyId)
        .eq("payment_request_id", requestId),
      supabaseAdmin
        .from("payment_request_approvals")
        .select("id,action,comments,created_at,approver_user_id,approver_role_id,approval_cycle")
        .eq("company_id", companyId)
        .eq("payment_request_id", requestId)
        .order("created_at", { ascending: true })
    ]);
    if (answersResult.error || logsResult.error) throw new Error(answersResult.error?.message || logsResult.error?.message || "Unable to load payment detail.");

    const logs = (logsResult.data ?? []) as any[];
    const userIds = [...new Set([payment.requested_by, payment.current_approver_user_id, ...logs.map((item) => item.approver_user_id)].filter(Boolean))] as string[];
    const roleIds = [...new Set([payment.current_approver_role_id, ...(payment.current_approver_role_ids ?? []), ...logs.map((item) => item.approver_role_id)].filter(Boolean))] as string[];
    const [profilesResult, rolesResult] = await Promise.all([
      userIds.length ? supabaseAdmin.from("profiles").select("id,full_name,email").eq("company_id", companyId).in("id", userIds) : Promise.resolve({ data: [], error: null }),
      roleIds.length ? supabaseAdmin.from("user_roles").select("id,name,code").eq("company_id", companyId).in("id", roleIds) : Promise.resolve({ data: [], error: null })
    ]);
    if (profilesResult.error || rolesResult.error) throw new Error(profilesResult.error?.message || rolesResult.error?.message || "Unable to resolve approval actors.");
    const profiles = new Map((profilesResult.data ?? []).map((item: any) => [item.id, item]));
    const roles = new Map((rolesResult.data ?? []).map((item: any) => [item.id, item]));
    const requester = profiles.get(payment.requested_by) as any;

    const history = [
      {
        id: `created-${payment.id}`,
        action: "created",
        actor: text(requester?.full_name || requester?.email) || "Requester",
        role: "Requester",
        comments: text(payment.remarks) || "Payment request created.",
        createdAt: payment.created_at
      },
      ...logs.map((item) => {
        const actor = profiles.get(item.approver_user_id) as any;
        const role = roles.get(item.approver_role_id) as any;
        return {
          id: item.id,
          action: text(item.action) || "updated",
          actor: text(actor?.full_name || actor?.email) || "System",
          role: text(role?.name || role?.code) || "Approval workflow",
          comments: text(item.comments),
          createdAt: item.created_at
        };
      }),
      ...(payment.processed_at && !logs.some((item) => text(item.action).toLowerCase() === "processed") ? [{ id: `processed-${payment.id}`, action: "processed", actor: "System", role: "Payment processing", comments: "Payment processing completed.", createdAt: payment.processed_at }] : [])
    ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

    const answers = (answersResult.data ?? []).map((item: any) => {
      const question = firstRelation(item.payment_head_questions as any) as any;
      return { id: item.id, label: text(question?.question_text) || "Supporting detail", value: text(item.answer_value), fileName: text(item.file_name), hasFile: Boolean(item.file_path) };
    });
    const currentRoleNames = [payment.current_approver_role_id, ...(payment.current_approver_role_ids ?? [])].map((id) => roles.get(id) as any).filter(Boolean).map((role) => text(role.name || role.code));
    const currentProfile = profiles.get(payment.current_approver_user_id) as any;
    const currentStage = text(currentProfile?.full_name || currentProfile?.email) || currentRoleNames.join(", ") || null;

    const rawAnswers=(answersResult.data??[]).map((a:any)=>({...a,payment_head_questions:firstRelation(a.payment_head_questions)}));
    const volumeDate=adhocApprovalContext(headResult.data.code,rawAnswers);
    const evidence=volumeDate?await loadPaymentVolume(companyId,payment.location_code,volumeDate,paymentVolumeToday()).then(data=>({data,error:''})).catch(()=>({data:null,error:'Station evidence unavailable. Retry before deciding.'})):null;
    return NextResponse.json({
      volume:evidence?.data??null,volumeError:evidence?.error??'',volumeDate,replacement:payment.adhoc_vehicle_snapshot??null,
      cost:{estimate:payment.amount_requested,actual:payment.amount,shipments:estimatedShipments(rawAnswers)},
      answers: answers.filter((item) => item.value && !item.hasFile),
      attachments: answers.filter((item) => item.hasFile).map((item) => ({ id: item.id, label: item.label, fileName: item.fileName || "Attachment" })),
      history,
      currentStage
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load Fleet payment detail." }, { status: 500 });
  }
}

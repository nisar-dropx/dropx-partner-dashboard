import { NextRequest, NextResponse } from "next/server";
import { userFacingError } from "@/lib/user-facing-error";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canCancelRegularization, cancelRegularizationRequest } from "@/lib/connect-regularization-cancel";

function isMissingRegularizationTable(message: unknown) {
  const text = String(message ?? "").toLowerCase();
  return text.includes("attendance_regularization") && (text.includes("does not exist") || text.includes("schema cache"));
}

/**
 * A worker's own attendance-correction request history, with each request's
 * approval-step trail. Queried directly against Supabase (unlike the rest of
 * the attendance surface, which proxies to the dashboard app) so "My
 * Requests" works regardless of that separate deployment's rollout state.
 */
export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    if (!accountId) throw new Error("Account is required.");
    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });

    const requestsResult = await supabaseAdmin
      .from("attendance_regularization_requests")
      .select("id, attendance_date, requested_in_time, requested_out_time, reason_code, remarks, attachment_path, status, review_remarks, created_at")
      .eq("company_id", worker.companyId)
      .eq("profile_type", worker.profileType)
      .eq("profile_id", worker.profileId)
      .is("request_kind", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (requestsResult.error) {
      if (isMissingRegularizationTable(requestsResult.error.message)) return NextResponse.json({ requests: [] });
      throw new Error(requestsResult.error.message);
    }
    const requests = requestsResult.data ?? [];
    if (!requests.length) return NextResponse.json({ requests: [] });

    const stepsResult = await supabaseAdmin
      .from("attendance_regularization_approval_steps")
      .select("id, request_id, step_order, step_name, status, decided_at")
      .in("request_id", requests.map((item) => item.id))
      .order("step_order", { ascending: true });
    if (stepsResult.error && !isMissingRegularizationTable(stepsResult.error.message)) throw new Error(stepsResult.error.message);
    const stepsByRequest = new Map<string, Array<{ stepOrder: number; stepName: string; status: string }>>();
    const approvedRequestIds = new Set<string>();
    for (const step of stepsResult.data ?? []) {
      if (step.status === "approved") approvedRequestIds.add(step.request_id);
      const list = stepsByRequest.get(step.request_id) ?? [];
      list.push({ stepOrder: step.step_order, stepName: step.step_name, status: step.status });
      stepsByRequest.set(step.request_id, list);
    }

    return NextResponse.json({
      requests: requests.map((item) => ({
        id: item.id,
        attendanceDate: item.attendance_date,
        requestedInTime: String(item.requested_in_time ?? "").slice(0, 5),
        requestedOutTime: String(item.requested_out_time ?? "").slice(0, 5),
        reasonCode: item.reason_code,
        remarks: item.remarks,
        hasAttachment: Boolean(item.attachment_path),
        status: item.status,
        reviewRemarks: item.review_remarks,
        createdAt: item.created_at,
        steps: stepsByRequest.get(item.id) ?? [],
        canCancel: canCancelRegularization(item.status, approvedRequestIds.has(item.id))
      }))
    });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to load attendance requests.") }, { status: 400 });
  }
}

/** Withdraws the worker's own attendance correction while no approver has approved it. */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { accountId?: unknown; profileType?: unknown; requestId?: unknown };
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) throw new Error("Account is required.");
    const worker = await resolveConnectAttendanceWorker({ accountId, profileType: String(body.profileType ?? "") });
    await cancelRegularizationRequest(worker, String(body.requestId ?? "").trim());
    return NextResponse.json({ ok: true, notice: "Attendance correction withdrawn." });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to withdraw the attendance correction.") }, { status: 400 });
  }
}

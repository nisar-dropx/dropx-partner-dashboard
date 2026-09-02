import { NextRequest, NextResponse } from "next/server";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import { supabaseAdmin } from "@/lib/supabase-admin";

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
    for (const step of stepsResult.data ?? []) {
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
        steps: stepsByRequest.get(item.id) ?? []
      }))
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load attendance requests." }, { status: 400 });
  }
}

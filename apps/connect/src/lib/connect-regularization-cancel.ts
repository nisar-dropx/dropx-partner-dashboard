import { supabaseAdmin } from "@/lib/supabase-admin";

// A worker can withdraw their own attendance correction, like a leave withdrawal, until any
// approver has approved a step. After that it has to run its course.
export const cancellableRegularizationStatuses = ["pending", "pending_manager", "pending_hr"];
// Same bucket the submit flow in app/api/connect/attendance/route.ts uploads proof to.
const REGULARIZATION_PROOF_BUCKET = "employee-profile-documents";

function db() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  return supabaseAdmin;
}

/** Request ids (from the given ones) that already have an approved step. */
export async function regularizationIdsWithApproval(companyId: string, requestIds: string[]) {
  if (!requestIds.length) return new Set<string>();
  const steps = await db().from("attendance_regularization_approval_steps")
    .select("request_id")
    .eq("company_id", companyId)
    .in("request_id", requestIds)
    .eq("status", "approved");
  if (steps.error) throw new Error(steps.error.message);
  return new Set((steps.data ?? []).map((step) => String(step.request_id)));
}

export function canCancelRegularization(status: unknown, hasApproval: boolean) {
  return cancellableRegularizationStatuses.includes(String(status ?? "")) && !hasApproval;
}

export async function cancelRegularizationRequest(worker: { companyId: string; profileType: string; profileId: string }, requestId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Attendance request is invalid.");
  const request = await db().from("attendance_regularization_requests")
    .select("id, status, attachment_path, attachment_path_out")
    .eq("company_id", worker.companyId)
    .eq("profile_type", worker.profileType)
    .eq("profile_id", worker.profileId)
    .eq("id", requestId)
    .is("request_kind", null)
    .maybeSingle();
  if (request.error) throw new Error(request.error.message);
  if (!request.data) throw new Error("Attendance request was not found.");
  if (!cancellableRegularizationStatuses.includes(String(request.data.status))) {
    throw new Error("This attendance correction has already been decided, so it can't be withdrawn.");
  }
  const approved = await regularizationIdsWithApproval(worker.companyId, [requestId]);
  if (approved.size) throw new Error("An approver has already approved this correction, so it can't be withdrawn.");

  const now = new Date().toISOString();
  // Status-guarded so a decision that lands at the same moment isn't overwritten.
  const update = await db().from("attendance_regularization_requests")
    .update({ status: "cancelled", updated_at: now })
    .eq("company_id", worker.companyId)
    .eq("id", requestId)
    .in("status", cancellableRegularizationStatuses)
    .select("id");
  if (update.error) throw new Error(update.error.message);
  if (!update.data?.length) throw new Error("This attendance correction was just decided, so it can't be withdrawn.");

  const steps = await db().from("attendance_regularization_approval_steps")
    .update({ status: "skipped", decision_note: "Withdrawn by requester", decided_at: now, updated_at: now })
    .eq("company_id", worker.companyId)
    .eq("request_id", requestId)
    .in("status", ["pending", "queued"]);
  if (steps.error) throw new Error(steps.error.message);

  // The supporting CCTV proof is deleted with the withdrawal. Only returned requests are reused by a
  // later submission, so a withdrawn request's files aren't referenced anywhere else. The paths are
  // cleared only once the files are gone, so a failed delete never leaves an untracked file behind;
  // the withdrawal itself still stands either way.
  const paths = [request.data.attachment_path, request.data.attachment_path_out]
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  if (paths.length) {
    const removed = await db().storage.from(REGULARIZATION_PROOF_BUCKET).remove(paths);
    if (!removed.error) {
      await db().from("attendance_regularization_requests")
        .update({ attachment_path: null, attachment_path_out: null, updated_at: now })
        .eq("company_id", worker.companyId)
        .eq("id", requestId);
    }
  }
}

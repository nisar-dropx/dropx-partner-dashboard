"use server";

import { revalidatePath } from "next/cache";
import { isStationFloorRosterDesignation } from "@/lib/approval-designation-labels";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadPeopleDesignations } from "@/lib/people-designation";
import { loadDirectReportsForSalaryHold, loadHoldForViewer, workerLocation } from "@/lib/ops-pulse/salary-hold-data";
import { ACTION_COPY, noteError, validateRaise, type SalaryHoldAction } from "@/lib/ops-pulse/salary-hold-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

function db() {
  if (!supabaseAdmin) throw new Error("Salary hold service unavailable.");
  return supabaseAdmin;
}

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const ACTIONS = Object.keys(ACTION_COPY) as SalaryHoldAction[];

/**
 * Re-verifies, server-side, that the signed-in user clears the station-floor
 * tier gate (Senior Store Manager and above only) for raising salary holds -
 * never trusts the client-rendered gate alone.
 */
async function assertDesignationTierCleared(companyId: string, userId: string) {
  const designationByUser = await loadPeopleDesignations(companyId, [userId]);
  const designation = designationByUser.get(userId);
  const cleared = Boolean(designation) && !isStationFloorRosterDesignation({
    name: designation?.name ?? "",
    code: designation?.code ?? null
  });
  if (!cleared) throw new Error("You do not have the required designation tier to place salary holds.");
}

const dbMessage = (error: { code?: string; message: string }, fallback: string) =>
  error.code === "P0001" ? error.message
  : /ops_salary_hold_(raise|transition)|schema cache/.test(error.message) ? "Salary hold approvals are not available until the latest database update is applied."
  : fallback;

/**
 * Raises a salary hold on one of the signed-in manager's current direct reports (re-resolved here, not
 * trusted from the form). It waits for the cluster manager of the person's station; payroll never sees
 * it until it is approved.
 */
export async function placeSalaryHold(formData: FormData): Promise<ActionResult> {
  let auth;
  try {
    auth = await requirePagePermissionOrThrow("ops_salary_hold", "access");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sign-in could not be verified." };
  }
  if (auth.readOnly) return { ok: false, message: "Read-only access cannot raise salary holds." };

  const workerType = String(formData.get("workerType") ?? "").trim();
  const workerId = String(formData.get("workerId") ?? "").trim();
  const input = {
    holdType: String(formData.get("holdType") ?? "").trim(),
    amount: String(formData.get("amount") ?? "").trim(),
    days: String(formData.get("days") ?? "").trim(),
    reason: String(formData.get("reason") ?? "").trim(),
  };
  if ((workerType !== "employee" && workerType !== "contractor") || !/^[0-9a-f-]{36}$/i.test(workerId))
    return { ok: false, message: "Select a worker to place a hold on." };
  const invalid = validateRaise(input);
  if (invalid) return { ok: false, message: invalid };

  try {
    const companyId = requireCompanyId(auth);
    await assertDesignationTierCleared(companyId, auth.userId);

    const { reports, error: reportsError } = await loadDirectReportsForSalaryHold(companyId, auth.userId);
    if (reportsError) return { ok: false, message: "Your reporting team could not be resolved. Please contact HR." };
    const target = reports.find((r) => r.workerType === workerType && r.workerId === workerId);
    if (!target) return { ok: false, message: "That worker is not currently one of your direct reports." };

    const result = await db().rpc("ops_salary_hold_raise", {
      p_company: companyId,
      p_worker_type: workerType,
      p_worker_id: workerId,
      p_location: await workerLocation(companyId, workerType, workerId),
      p_hold_type: input.holdType,
      p_amount: input.holdType === "amount" ? Number(input.amount) : null,
      p_days: input.holdType === "days" ? Number(input.days) : null,
      p_reason: input.reason,
      p_actor: auth.userId,
      p_actor_name: auth.fullName || auth.email || "Ops manager",
    });
    if (result.error) return { ok: false, message: dbMessage(result.error, "The salary hold could not be saved.") };

    revalidatePath("/attendance/salary-hold");
    return { ok: true, message: `Salary hold raised for ${target.displayName}. It waits for the cluster manager's approval.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The salary hold could not be placed." };
  }
}

/**
 * Every other step: withdraw, request/decide cancellation, approve/reject, request/decide release.
 * The viewer's allowed actions are recomputed on the server (requester, or the station's cluster
 * manager who did not make the request); the database enforces the state machine and version.
 */
export async function actOnSalaryHold(formData: FormData): Promise<ActionResult> {
  let auth;
  try {
    auth = await requirePagePermissionOrThrow("ops_salary_hold", "access");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sign-in could not be verified." };
  }
  if (auth.readOnly) return { ok: false, message: "Read-only access cannot change salary holds." };

  const holdId = String(formData.get("holdId") ?? "").trim();
  const action = String(formData.get("action") ?? "").trim() as SalaryHoldAction;
  const version = Number(formData.get("version"));
  const note = String(formData.get("note") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(holdId) || !ACTIONS.includes(action) || !Number.isInteger(version))
    return { ok: false, message: "This request is invalid. Refresh and try again." };
  const invalidNote = noteError(action, note);
  if (invalidNote) return { ok: false, message: invalidNote };

  try {
    const companyId = requireCompanyId(auth);
    const hold = await loadHoldForViewer(companyId, auth.userId, holdId);
    if (!hold.actions.includes(action)) {
      return {
        ok: false,
        message: ["approve", "reject", "approve_cancel", "reject_cancel", "approve_release", "reject_release"].includes(action)
          ? "Only the cluster manager of this person's station can decide this, and never their own request."
          : "Only the person who raised this hold can do that, and only at this stage.",
      };
    }
    if (["withdraw", "request_cancel", "request_release"].includes(action)) await assertDesignationTierCleared(companyId, auth.userId);
    const result = await db().rpc("ops_salary_hold_transition", {
      p_company: companyId,
      p_hold: holdId,
      p_action: action,
      p_version: version,
      p_actor: auth.userId,
      p_actor_name: auth.fullName || auth.email || "Ops user",
      p_note: note || null,
    });
    if (result.error) return { ok: false, message: dbMessage(result.error, "The salary hold could not be updated.") };

    revalidatePath("/attendance/salary-hold");
    const done: Record<SalaryHoldAction, string> = {
      approve: "Hold approved. It is withheld in the next payroll.",
      reject: "Hold rejected.",
      withdraw: "Hold withdrawn.",
      request_cancel: "Cancellation requested. The cluster manager will decide it.",
      approve_cancel: "Cancellation approved. The hold will not reach payroll.",
      reject_cancel: "Cancellation declined. The hold stays approved.",
      request_release: "Release requested. The cluster manager will decide it.",
      approve_release: "Release approved. The withheld amount is paid back in payroll.",
      reject_release: "Release declined. The amount stays withheld.",
    };
    return { ok: true, message: done[action] };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The salary hold could not be updated." };
  }
}

/** Kept for existing callers; same as requesting cancellation through actOnSalaryHold. */
export async function requestSalaryHoldCancellation(formData: FormData): Promise<ActionResult> {
  const form = new FormData();
  form.set("holdId", String(formData.get("holdId") ?? ""));
  form.set("action", "request_cancel");
  form.set("version", String(formData.get("version") ?? ""));
  form.set("note", String(formData.get("note") ?? ""));
  return actOnSalaryHold(form);
}

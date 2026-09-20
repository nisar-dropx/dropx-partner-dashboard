"use server";

import { revalidatePath } from "next/cache";
import { isStationFloorRosterDesignation } from "@/lib/approval-designation-labels";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadPeopleDesignations } from "@/lib/people-designation";
import { loadDirectReportsForSalaryHold } from "@/lib/ops-pulse/salary-hold-data";
import { supabaseAdmin } from "@/lib/supabase-admin";

function db() {
  if (!supabaseAdmin) throw new Error("Salary hold service unavailable.");
  return supabaseAdmin;
}

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const REASON_MIN_LENGTH = 5;

/**
 * Re-verifies, server-side, that the signed-in user clears the station-floor
 * tier gate (Senior Store Manager and above only) for placing/cancelling
 * salary holds - never trusts the client-rendered gate alone.
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

/**
 * Places a new standing salary hold on a worker who is genuinely one of the
 * signed-in manager's current direct reports (re-resolved fresh here, not
 * trusted from the submitted form). Inserts into ops_salary_holds with
 * status "pending"; HRMS's own payroll run picks it up automatically.
 */
export async function placeSalaryHold(formData: FormData): Promise<ActionResult> {
  let auth;
  try {
    auth = await requirePagePermissionOrThrow("ops_salary_hold", "access");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sign-in could not be verified." };
  }

  const workerType = String(formData.get("workerType") ?? "").trim();
  const workerId = String(formData.get("workerId") ?? "").trim();
  const holdType = String(formData.get("holdType") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const daysRaw = String(formData.get("days") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (workerType !== "employee" && workerType !== "contractor") {
    return { ok: false, message: "Select a worker to place a hold on." };
  }
  if (!workerId) return { ok: false, message: "Select a worker to place a hold on." };
  if (holdType !== "amount" && holdType !== "days") {
    return { ok: false, message: "Choose whether this hold is an amount or a number of days." };
  }
  if (reason.length < REASON_MIN_LENGTH) {
    return { ok: false, message: `Explain the reason for this hold (at least ${REASON_MIN_LENGTH} characters).` };
  }

  let amount: number | null = null;
  let days: number | null = null;
  if (holdType === "amount") {
    amount = Number(amountRaw);
    if (!amountRaw || !Number.isFinite(amount) || amount <= 0) {
      return { ok: false, message: "Enter a valid hold amount greater than zero." };
    }
  } else {
    days = Number(daysRaw);
    if (!daysRaw || !Number.isFinite(days) || days <= 0) {
      return { ok: false, message: "Enter a valid number of days greater than zero." };
    }
  }

  try {
    const companyId = requireCompanyId(auth);
    await assertDesignationTierCleared(companyId, auth.userId);

    const { reports, error: reportsError } = await loadDirectReportsForSalaryHold(companyId, auth.userId);
    if (reportsError) return { ok: false, message: "Your reporting team could not be resolved. Please contact HR." };
    const target = reports.find((r) => r.workerType === workerType && r.workerId === workerId);
    if (!target) return { ok: false, message: "That worker is not currently one of your direct reports." };

    const insertResult = await db().from("ops_salary_holds").insert({
      company_id: companyId,
      worker_type: workerType,
      worker_id: workerId,
      hold_type: holdType,
      amount,
      days,
      reason,
      status: "pending",
      requested_by_user_id: auth.userId,
      requested_at: new Date().toISOString()
    });
    if (insertResult.error) return { ok: false, message: "The salary hold could not be saved." };

    revalidatePath("/attendance/salary-hold");
    return { ok: true, message: "Salary hold placed." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The salary hold could not be placed." };
  }
}

/**
 * Flags a hold for HR review by setting status to "cancel_requested" - a
 * manager can never self-cancel their own hold; only HR can move a hold to
 * "cancelled" (a separate, already-built action in the dropx-hrms repo).
 */
export async function requestSalaryHoldCancellation(formData: FormData): Promise<ActionResult> {
  let auth;
  try {
    auth = await requirePagePermissionOrThrow("ops_salary_hold", "access");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sign-in could not be verified." };
  }

  const holdId = String(formData.get("holdId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!holdId) return { ok: false, message: "Invalid salary hold." };

  try {
    const companyId = requireCompanyId(auth);
    await assertDesignationTierCleared(companyId, auth.userId);

    const holdResult = await db().from("ops_salary_holds")
      .select("id,status,requested_by_user_id,company_id")
      .eq("id", holdId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (holdResult.error || !holdResult.data) return { ok: false, message: "Salary hold could not be found." };
    const hold = holdResult.data;
    if (hold.requested_by_user_id !== auth.userId) return { ok: false, message: "You can only request cancellation of holds you placed." };
    if (hold.status !== "pending") return { ok: false, message: "Only a pending hold can have its cancellation requested." };

    const updateResult = await db().from("ops_salary_holds").update({
      status: "cancel_requested",
      cancel_requested_by_user_id: auth.userId,
      cancel_requested_at: new Date().toISOString(),
      cancel_request_note: note || null
    }).eq("id", holdId).eq("company_id", companyId).eq("status", "pending");
    if (updateResult.error) return { ok: false, message: "Cancellation request could not be saved." };

    revalidatePath("/attendance/salary-hold");
    return { ok: true, message: "Cancellation requested. HR will review it." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The cancellation request could not be submitted." };
  }
}

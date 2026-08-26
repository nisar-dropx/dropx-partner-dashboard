"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isCompanyOwner, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function finish(params: { error?: string; notice?: string }) {
  redirect(`/payments/advance-request?${new URLSearchParams(params).toString()}`);
}

async function decideAdvanceRequest(formData: FormData, decision: "approved" | "rejected") {
  const authorization = await requirePagePermission("advance_requests", "edit");
  if (!isCompanyOwner(authorization)) redirect("/unauthorized?page=advance_requests&action=owner");
  if (!supabaseAdmin) finish({ error: "Supabase service role key is not configured." });

  const companyId = requireCompanyId(authorization);
  const requestId = value(formData, "requestId");
  const comment = value(formData, "comment");
  if (!requestId) finish({ error: "Advance request is required." });
  if (decision === "rejected" && !comment) finish({ error: "Add a reason before rejecting the request." });

  const approvedAmountText = value(formData, "approvedAmount");
  const approvedAmount = decision === "approved" ? Number(approvedAmountText) : null;
  if (decision === "approved" && (!Number.isFinite(approvedAmount) || Number(approvedAmount) <= 0)) {
    finish({ error: "Enter a valid approved amount." });
  }

  const result = await supabaseAdmin!
    .from("payment_advance_requests")
    .update({
      status: decision,
      approved_amount: approvedAmount,
      decision_comment: comment || null,
      updated_at: new Date().toISOString()
    })
    .eq("company_id", companyId)
    .eq("id", requestId)
    .in("status", ["submitted", "in_review"])
    .select("id")
    .maybeSingle();

  if (result.error) finish({ error: result.error.message });
  if (!result.data) finish({ error: "This request has already been decided or no longer exists." });

  revalidatePath("/payments/advance-request");
  finish({ notice: `Advance request ${decision}.` });
}

export async function approveAdvanceRequest(formData: FormData) {
  return decideAdvanceRequest(formData, "approved");
}

export async function rejectAdvanceRequest(formData: FormData) {
  return decideAdvanceRequest(formData, "rejected");
}

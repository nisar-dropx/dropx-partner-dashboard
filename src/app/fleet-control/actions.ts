"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  approvePaymentRequest,
  rejectPaymentRequest,
  returnPaymentRequest
} from "@/app/payments/approvals/actions";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isFleetManagerPaymentHead } from "@/lib/fleet-control-payment-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function message(error: unknown) {
  return error instanceof Error ? error.message : "The payment request could not be updated.";
}

function destination(formData: FormData, key: "notice" | "error", value: string) {
  const params = new URLSearchParams({ section: "approvals", [key]: value });
  const requestId = String(formData.get("request_id") ?? "").trim();
  if (requestId) params.set("request", requestId);
  return `/fleet-control?${params.toString()}`;
}

async function requireFleetManagerPayment(formData: FormData) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const authorization = await getAuthorization();
  if (!authorization) throw new Error("Your session has expired. Sign in again.");
  const companyId = requireCompanyId(authorization);
  const requestId = String(formData.get("request_id") ?? "").trim();
  if (!requestId) throw new Error("Payment request is required.");

  const request = await supabaseAdmin
    .from("payment_requests")
    .select("payment_head_id")
    .eq("company_id", companyId)
    .eq("id", requestId)
    .maybeSingle();
  if (request.error) throw new Error(request.error.message);
  if (!request.data?.payment_head_id) throw new Error("Payment request was not found.");

  const head = await supabaseAdmin
    .from("payment_heads")
    .select("code,name")
    .eq("company_id", companyId)
    .eq("id", request.data.payment_head_id)
    .maybeSingle();
  if (head.error) throw new Error(head.error.message);
  if (!head.data || !isFleetManagerPaymentHead(head.data)) {
    throw new Error("This payment is outside Fleet Manager approval. Ad-hoc van activity is visibility-only in Fleet.");
  }
}

async function run(
  formData: FormData,
  action: (payload: FormData) => Promise<string | void>,
  success: string
) {
  let redirectTo: string;
  try {
    await requireFleetManagerPayment(formData);
    const emailReason = await action(formData);
    const notice = emailReason ? `${success} Notification was not sent: ${emailReason}` : success;
    revalidatePath("/fleet-control");
    redirectTo = destination(formData, "notice", notice);
  } catch (error) {
    redirectTo = destination(formData, "error", message(error));
  }
  redirect(redirectTo);
}

export async function approveFleetPayment(formData: FormData) {
  await run(formData, approvePaymentRequest, "Vehicle payment approved.");
}

export async function returnFleetPayment(formData: FormData) {
  await run(formData, returnPaymentRequest, "Vehicle payment returned for correction.");
}

export async function rejectFleetPayment(formData: FormData) {
  await run(formData, rejectPaymentRequest, "Vehicle payment rejected.");
}

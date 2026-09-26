"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  approvePaymentRequest,
  rejectPaymentRequest,
  returnPaymentRequest
} from "@/app/payments/approvals/actions";

function message(error: unknown) {
  return error instanceof Error ? error.message : "The payment request could not be updated.";
}

function destination(formData: FormData, key: "notice" | "error", value: string) {
  const params = new URLSearchParams({ section: "approvals", [key]: value });
  const requestId = String(formData.get("request_id") ?? "").trim();
  if (requestId) params.set("request", requestId);
  return `/fleet-control?${params.toString()}`;
}

async function run(
  formData: FormData,
  action: (payload: FormData) => Promise<string | void>,
  success: string
) {
  let redirectTo: string;
  try {
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

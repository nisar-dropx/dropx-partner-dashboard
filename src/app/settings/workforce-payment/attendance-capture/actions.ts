"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  WORKFORCE_ATTENDANCE_CAPTURE_METHODS,
  type WorkforceAttendanceCaptureMethod
} from "@/lib/workforce-attendance-capture";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function validMonth(value: string) {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const [year, month] = value.split("-").map(Number);
  return year >= 2000 && year <= 9999 && month >= 1 && month <= 12;
}

function isRedirectError(error: unknown) {
  return String((error as { digest?: unknown })?.digest ?? "").startsWith("NEXT_REDIRECT");
}

function settingsRedirect(params: { error?: string; notice?: string }): never {
  cookies().set("dropx_workforce_attendance_capture_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 30,
    path: "/settings/workforce-payment/attendance-capture",
    sameSite: "lax"
  });
  redirect("/settings/workforce-payment/attendance-capture");
}

export async function saveWorkforceAttendanceCaptureSetting(formData: FormData) {
  try {
    const authorization = await requirePagePermissionOrThrow("payment_settings", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

    const captureMethod = clean(formData.get("capture_method")) as WorkforceAttendanceCaptureMethod;
    if (!WORKFORCE_ATTENDANCE_CAPTURE_METHODS.includes(captureMethod)) {
      throw new Error("Choose a valid attendance capture method.");
    }

    let minimumDailyDeliveries: number | null = null;
    if (captureMethod === "shipment_data") {
      const minimumText = clean(formData.get("minimum_daily_deliveries"));
      minimumDailyDeliveries = Number(minimumText);
      if (!minimumText || !Number.isInteger(minimumDailyDeliveries) || minimumDailyDeliveries < 1 || minimumDailyDeliveries > 100000) {
        throw new Error("Minimum daily deliveries must be a whole number from 1 to 100000.");
      }
    }

    const reviewText = clean(formData.get("review_below_deliveries"));
    const reviewBelow = reviewText ? Number(reviewText) : null;
    if (reviewBelow !== null && (!Number.isInteger(reviewBelow) || reviewBelow < 1 || reviewBelow > 100000)) throw new Error("Review threshold must be from 1 to 100000, or blank.");
    const effectiveMonth = clean(formData.get("effective_from"));
    if (!validMonth(effectiveMonth)) {
      throw new Error("Choose a valid effective month.");
    }
    const changeReason = clean(formData.get("change_reason"));
    if (changeReason.length < 3 || changeReason.length > 250) {
      throw new Error("Change reason must be from 3 to 250 characters.");
    }

    const saved = await supabaseAdmin.rpc("save_workforce_attendance_capture_setting_v2", {
      p_company_id: companyId,
      p_capture_method: captureMethod,
      p_minimum_daily_deliveries: minimumDailyDeliveries,
      p_review_below_deliveries: reviewBelow,
      p_effective_from: `${effectiveMonth}-01`,
      p_change_reason: changeReason,
      p_actor_user_id: authorization.userId
    });
    if (saved.error) throw new Error(saved.error.message);

    revalidatePath("/settings");
    revalidatePath("/settings/workforce-payment");
    revalidatePath("/settings/workforce-payment/attendance-capture");
    revalidatePath("/payments/workforce-payouts");
    revalidatePath("/cps");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    settingsRedirect({
      error: error instanceof Error ? error.message : "Unable to save attendance capture settings."
    });
  }

  settingsRedirect({ notice: "Attendance capture policy saved. Workforce payout estimates now use this effective-dated setting." });
}

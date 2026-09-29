"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  DEFAULT_WORKFORCE_PAYMENT_POLICY,
  WORKFORCE_PAYMENT_METHODS,
  workforcePaymentMethodFields,
  type WorkforcePaymentMethod
} from "@/lib/workforce-payment-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function wholeNumber(value: FormDataEntryValue | null, field: string, minimum: number, maximum: number) {
  const text = clean(value);
  const parsed = Number(text);
  if (!text || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function positiveNumber(value: FormDataEntryValue | null, field: string, maximum: number) {
  const parsed = Number(clean(value));
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > maximum || !Number.isInteger(parsed * 2)) {
    throw new Error(`${field} must be from 0.5 to ${maximum}, in half-unit steps.`);
  }
  return Math.round(parsed * 100) / 100;
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
  cookies().set("dropx_workforce_payment_settings_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 30,
    path: "/settings",
    sameSite: "lax"
  });
  redirect("/settings/workforce-payment");
}

export async function saveWorkforcePaymentSettings(formData: FormData) {
  try {
    const authorization = await requirePagePermissionOrThrow("payment_settings", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

    const calculationMethod = clean(formData.get("calculation_method")) as WorkforcePaymentMethod;
    if (!WORKFORCE_PAYMENT_METHODS.includes(calculationMethod)) {
      throw new Error("Choose a valid workforce payment calculation method.");
    }

    const fields = workforcePaymentMethodFields(calculationMethod);
    const paidOffDays = fields.paidOffDays
      ? wholeNumber(formData.get("paid_off_days"), "Paid off days", 0, 10)
      : DEFAULT_WORKFORCE_PAYMENT_POLICY.paid_off_days;
    const workUnitsPerPaidOff = fields.workUnitsPerPaidOff
      ? positiveNumber(formData.get("work_units_per_paid_off"), "Work units per paid off", 31)
      : DEFAULT_WORKFORCE_PAYMENT_POLICY.work_units_per_paid_off;
    const effectiveMonth = clean(formData.get("effective_from"));
    if (!validMonth(effectiveMonth)) {
      throw new Error("Choose a valid effective month.");
    }
    const changeReason = clean(formData.get("change_reason"));
    if (changeReason.length < 3 || changeReason.length > 250) {
      throw new Error("Change reason must be from 3 to 250 characters.");
    }

    const effectiveFrom = `${effectiveMonth}-01`;

    const saved = await supabaseAdmin.rpc("save_workforce_payment_setting", {
      p_company_id: companyId,
      p_calculation_method: calculationMethod,
      p_paid_off_days: paidOffDays,
      p_work_units_per_paid_off: workUnitsPerPaidOff,
      p_cap_at_monthly_amount: formData.get("cap_at_monthly_amount") === "on",
      p_effective_from: effectiveFrom,
      p_change_reason: changeReason,
      p_actor_user_id: authorization.userId
    });
    if (saved.error) throw new Error(saved.error.message);

    revalidatePath("/settings");
    revalidatePath("/settings/workforce-payment");
    revalidatePath("/payments/workforce-payouts");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    settingsRedirect({
      error: error instanceof Error ? error.message : "Unable to save workforce payment settings."
    });
  }

  settingsRedirect({ notice: "Workforce payment policy saved." });
}

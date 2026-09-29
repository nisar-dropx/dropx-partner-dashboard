"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  WORKFORCE_PAYMENT_METHODS,
  type WorkforcePaymentMethod
} from "@/lib/workforce-payment-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function indiaMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Unable to determine the current month.");
  return `${year}-${month}`;
}

function addMonths(monthValue: string, amount: number) {
  const [year, month] = monthValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
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

    const paidOffDays = wholeNumber(formData.get("paid_off_days"), "Paid off days", 0, 10);
    const workUnitsPerPaidOff = positiveNumber(formData.get("work_units_per_paid_off"), "Work units per paid off", 31);
    const effectiveMonth = clean(formData.get("effective_from"));
    if (!validMonth(effectiveMonth)) {
      throw new Error("Choose a valid effective month.");
    }
    const changeReason = clean(formData.get("change_reason"));
    if (changeReason.length < 3 || changeReason.length > 250) {
      throw new Error("Change reason must be from 3 to 250 characters.");
    }

    const currentMonth = indiaMonth();
    const firstAllowedMonth = addMonths(currentMonth, 1);
    const lastAllowedMonth = addMonths(currentMonth, 24);
    if (effectiveMonth < firstAllowedMonth || effectiveMonth > lastAllowedMonth) {
      throw new Error(`Effective month must be from ${firstAllowedMonth} through ${lastAllowedMonth}. Once a month begins, its policy is locked.`);
    }
    const effectiveFrom = `${effectiveMonth}-01`;

    const existing = await supabaseAdmin
      .from("workforce_payment_settings")
      .select("id")
      .eq("company_id", companyId)
      .eq("effective_from", effectiveFrom)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);

    const now = new Date().toISOString();
    const payload = {
      company_id: companyId,
      calculation_method: calculationMethod,
      paid_off_days: paidOffDays,
      work_units_per_paid_off: workUnitsPerPaidOff,
      cap_at_monthly_amount: formData.get("cap_at_monthly_amount") === "on",
      effective_from: effectiveFrom,
      change_reason: changeReason,
      updated_by: authorization.userId,
      updated_at: now,
      ...(existing.data ? {} : { created_by: authorization.userId, created_at: now })
    };
    const saved = await supabaseAdmin
      .from("workforce_payment_settings")
      .upsert(payload, { onConflict: "company_id,effective_from" });
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

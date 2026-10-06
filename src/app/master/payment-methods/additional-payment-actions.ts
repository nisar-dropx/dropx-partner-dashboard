"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  isAdditionalPaymentCalculationType,
  normalizeAdditionalPaymentCode,
  type AdditionalPaymentCalculationType
} from "@/lib/workforce-additional-payments";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function additionalPaymentRedirect(params: { error?: string; notice?: string }) {
  cookies().set("dropx_payment_method_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 15,
    path: "/master/payment-methods",
    sameSite: "lax"
  });
  redirect("/master/payment-methods?additionalFields=1");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to save the additional payment field.";
}

function additionalPaymentValues(formData: FormData) {
  const name = text(formData, "name");
  const calculationTypeValue = text(formData, "calculation_type");
  if (!name) throw new Error("Name is required.");
  if (!isAdditionalPaymentCalculationType(calculationTypeValue)) throw new Error("Select a valid calculation type.");
  const calculationType: AdditionalPaymentCalculationType = calculationTypeValue;

  const rawDefaultRate = text(formData, "default_rate_value");
  let defaultRateValue: number | null = null;
  if (calculationType !== "manual_amount" && !rawDefaultRate) {
    throw new Error("Rate per unit is required.");
  }
  if (calculationType !== "manual_amount") {
    defaultRateValue = Number(rawDefaultRate);
    if (!Number.isFinite(defaultRateValue) || defaultRateValue < 0) {
      throw new Error("Rate per unit must be zero or greater.");
    }
  }

  return {
    name,
    description: text(formData, "description") || null,
    calculation_type: calculationType,
    default_rate_value: calculationType === "manual_amount" ? null : defaultRateValue
  };
}

export async function createAdditionalPaymentField(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Database connection is not configured.");
    const codeCandidate = text(formData, "code").toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!codeCandidate) throw new Error("Code is required.");
    const code = normalizeAdditionalPaymentCode(codeCandidate);
    const values = additionalPaymentValues(formData);
    const { error } = await supabaseAdmin.from("workforce_additional_payment_fields").insert({
      company_id: companyId,
      code,
      ...values,
      is_active: text(formData, "is_active") === "true",
      created_by: authorization.userId,
      updated_by: authorization.userId
    });
    if (error) throw new Error(error.code === "23505" ? `An additional payment field with code ${code} already exists.` : error.message);
  } catch (error) {
    additionalPaymentRedirect({ error: errorMessage(error) });
  }
  revalidatePath("/master/payment-methods");
  additionalPaymentRedirect({ notice: "Additional payment field saved." });
}

export async function updateAdditionalPaymentField(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Database connection is not configured.");
    const id = text(formData, "id");
    if (!id) throw new Error("Additional payment field is required.");
    const values = additionalPaymentValues(formData);
    const result = await supabaseAdmin.from("workforce_additional_payment_fields").update({
      ...values,
      is_active: text(formData, "is_active") === "true",
      updated_by: authorization.userId,
      updated_at: new Date().toISOString()
    }).eq("company_id", companyId).eq("id", id).select("id").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("Additional payment field was not found.");
  } catch (error) {
    additionalPaymentRedirect({ error: errorMessage(error) });
  }
  revalidatePath("/master/payment-methods");
  additionalPaymentRedirect({ notice: "Additional payment field saved." });
}

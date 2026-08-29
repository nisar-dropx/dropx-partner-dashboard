"use server";

import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function deductionValues(formData: FormData) {
  const calculationType = text(formData, "calculation_type");
  if (!["fixed", "percentage", "manual"].includes(calculationType)) {
    throw new Error("Select a valid deduction type.");
  }
  const defaultValue = Number(formData.get("default_value") ?? 0);
  if (!Number.isFinite(defaultValue) || defaultValue < 0) {
    throw new Error("Deduction value must be zero or greater.");
  }
  if (calculationType === "percentage" && defaultValue > 100) {
    throw new Error("Percentage cannot be more than 100.");
  }
  if (calculationType === "percentage" && text(formData, "calculation_base") !== "gross_earnings") {
    throw new Error("Select a valid calculation base.");
  }
  return {
    calculation_type: calculationType as "fixed" | "percentage" | "manual",
    default_value: defaultValue,
    applies_to_all: calculationType !== "manual" && formData.get("applies_to_all") === "yes"
  };
}

export async function createDeductionHead(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Database connection is not configured.");
  const code = text(formData, "code").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const name = text(formData, "name");
  if (!code || !name) throw new Error("Deduction code and name are required.");
  const deduction = deductionValues(formData);
  const { error } = await supabaseAdmin.from("workforce_deduction_heads").insert({
    company_id: companyId,
    code,
    name,
    description: text(formData, "description") || null,
    ...deduction,
    is_active: true
  });
  if (error) throw new Error(error.message);
  revalidatePath("/master/payment-methods");
  revalidatePath("/payments/workforce-payouts");
}

export async function updateDeductionHead(formData: FormData) {
  const authorization = await requirePagePermission("payment_methods", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Database connection is not configured.");
  const id = text(formData, "id");
  const deduction = deductionValues(formData);
  const { error } = await supabaseAdmin.from("workforce_deduction_heads").update({
    name: text(formData, "name"),
    description: text(formData, "description") || null,
    ...deduction,
    is_active: formData.get("is_active") === "true",
    updated_at: new Date().toISOString()
  }).eq("company_id", companyId).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/master/payment-methods");
  revalidatePath("/payments/workforce-payouts");
}

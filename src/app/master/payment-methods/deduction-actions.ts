"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function deductionRedirect(params: { error?: string; notice?: string }) {
  cookies().set("dropx_payment_method_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 15,
    path: "/master/payment-methods",
    sameSite: "lax"
  });
  redirect("/master/payment-methods?deductions=1");
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unable to save the deduction head.";
}

function selectedCategoryCodes(formData: FormData) {
  return Array.from(new Set(formData.getAll("workforce_category_codes")
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => /^[a-z0-9_]+$/.test(value))));
}

function deductionValues(formData: FormData, isSystemTds = false) {
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
  const percentageWithoutPan = isSystemTds ? Number(formData.get("percentage_without_pan") ?? 0) : 0;
  if (!Number.isFinite(percentageWithoutPan) || percentageWithoutPan < 0 || percentageWithoutPan > 100) {
    throw new Error("Without PAN percentage must be between 0 and 100.");
  }
  const workforceCategoryCodes = isSystemTds ? selectedCategoryCodes(formData) : [];
  if (isSystemTds && !workforceCategoryCodes.length) {
    throw new Error("Select at least one applicable workforce category for TDS.");
  }
  return {
    calculation_type: (isSystemTds ? "percentage" : calculationType) as "fixed" | "percentage" | "manual",
    default_value: defaultValue,
    percentage_without_pan: percentageWithoutPan,
    workforce_category_codes: workforceCategoryCodes,
    applies_to_all: isSystemTds || (calculationType !== "manual" && formData.get("applies_to_all") === "yes")
  };
}

async function assertWorkforceCategories(companyId: string, codes: string[]) {
  if (!codes.length || !supabaseAdmin) return;
  const result = await supabaseAdmin.from("workforce_categories")
    .select("code")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("code", codes);
  if (result.error) throw new Error(result.error.message);
  const availableCodes = new Set((result.data ?? []).map((row) => String(row.code)));
  if (codes.some((code) => !availableCodes.has(code))) {
    throw new Error("One or more selected workforce categories are unavailable.");
  }
}

export async function createDeductionHead(formData: FormData) {
  try {
    const authorization = await requirePagePermission("payment_methods", "add");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Database connection is not configured.");
    const code = text(formData, "code").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const name = text(formData, "name");
    if (!code || !name) throw new Error("Deduction code and name are required.");
    if (code === "TDS") throw new Error("TDS is a protected system deduction head.");
    const deduction = deductionValues(formData);
    const { error } = await supabaseAdmin.from("workforce_deduction_heads").insert({
      company_id: companyId,
      code,
      name,
      description: text(formData, "description") || null,
      ...deduction,
      is_active: true
    });
    if (error) throw new Error(error.code === "23505" ? `A deduction head with code ${code} already exists.` : error.message);
  } catch (error) {
    deductionRedirect({ error: message(error) });
  }
  revalidatePath("/master/payment-methods");
  revalidatePath("/payments/workforce-payouts");
  deductionRedirect({ notice: "Deduction head saved." });
}

export async function updateDeductionHead(formData: FormData) {
  try {
    const authorization = await requirePagePermission("payment_methods", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Database connection is not configured.");
    const id = text(formData, "id");
    const existingResult = await supabaseAdmin.from("workforce_deduction_heads")
    .select("code, is_system")
    .eq("company_id", companyId)
    .eq("id", id)
    .maybeSingle();
    if (existingResult.error) throw new Error(existingResult.error.message);
    if (!existingResult.data) throw new Error("Deduction head was not found.");
    const isSystemTds = existingResult.data.is_system && existingResult.data.code === "TDS";
    if (existingResult.data.is_system && !isSystemTds) throw new Error("Unsupported system deduction head.");
    const deduction = deductionValues(formData, isSystemTds);
    await assertWorkforceCategories(companyId, deduction.workforce_category_codes);
    const { error } = await supabaseAdmin.from("workforce_deduction_heads").update({
    name: isSystemTds ? "TDS Deduction" : text(formData, "name"),
    description: text(formData, "description") || null,
    ...deduction,
    is_active: formData.get("is_active") === "true",
    updated_at: new Date().toISOString()
    }).eq("company_id", companyId).eq("id", id);
    if (error) throw new Error(error.message);
  } catch (error) {
    deductionRedirect({ error: message(error) });
  }
  revalidatePath("/master/payment-methods");
  revalidatePath("/payments/workforce-payouts");
  deductionRedirect({ notice: "Deduction head saved." });
}

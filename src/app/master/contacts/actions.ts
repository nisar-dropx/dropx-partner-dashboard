"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function required(value: FormDataEntryValue | null, field: string) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

function optional(value: FormDataEntryValue | null) {
  return String(value ?? "").trim() || null;
}

function normalizeAccount(value: string) {
  const result = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (result.length < 4 || result.length > 30) throw new Error("Bank account number must contain 4 to 30 letters or digits.");
  return result;
}

function normalizeIfsc(value: string) {
  const result = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (result.length !== 11) throw new Error("IFSC must contain exactly 11 letters or digits.");
  return result;
}

function payload(formData: FormData) {
  const upiId = optional(formData.get("upi_id"));
  return {
    account_holder_name: required(formData.get("account_holder_name"), "Account holder name"),
    bank_account_no: upiId ? null : normalizeAccount(required(formData.get("bank_account_no"), "Bank account no")),
    contact_no: optional(formData.get("contact_no")),
    email: optional(formData.get("email")),
    ifsc: upiId ? null : normalizeIfsc(required(formData.get("ifsc"), "IFSC")),
    upi_id: upiId?.toLowerCase() ?? null,
    updated_at: new Date().toISOString()
  };
}

export async function createContact(formData: FormData) {
  const authorization = await requirePagePermission("master_contacts", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const { error } = await supabaseAdmin.from("payment_contacts").insert(withCompany({
    ...payload(formData), created_by: authorization.userId
  }, companyId));
  if (error) throw new Error(error.code === "23505" ? "This beneficiary already exists in Contacts." : error.message);
  revalidatePath("/master/contacts");
}

export async function updateContact(formData: FormData) {
  const authorization = await requirePagePermission("master_contacts", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const id = required(formData.get("id"), "Contact");
  const { error } = await supabaseAdmin.from("payment_contacts").update(payload(formData)).eq("id", id).eq("company_id", companyId);
  if (error) throw new Error(error.code === "23505" ? "This beneficiary already exists in Contacts." : error.message);
  revalidatePath("/master/contacts");
  redirect("/master/contacts");
}

export async function deleteContact(formData: FormData) {
  const authorization = await requirePagePermission("master_contacts", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const id = required(formData.get("id"), "Contact");
  const { error } = await supabaseAdmin.from("payment_contacts").delete().eq("id", id).eq("company_id", companyId);
  if (error) throw new Error(error.message);
  revalidatePath("/master/contacts");
  redirect("/master/contacts");
}

"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isFinanceHostName } from "@/lib/finance/surface";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function saveReimbursementMaster(
  kind: string,
  input: Record<string, unknown>,
) {
  const host = headers().get("x-forwarded-host") ?? headers().get("host") ?? "";
  if (!isFinanceHostName(host)) notFound();
  const auth = await requirePagePermission(
    "master_payment_heads",
    input.id ? "edit" : "add",
  );
  try {
    const companyId = requireCompanyId(auth);
    if (auth.readOnly || auth.isPreview || !auth.hasAllLocationAccess)
      throw new Error("Company-wide Finance master access is required.");
    if (!supabaseAdmin) throw new Error("Finance database is unavailable.");
    if (!["head", "limit", "payment_mapping"].includes(kind))
      throw new Error("Invalid master type.");
    const { error } = await supabaseAdmin.rpc(
      "finance_save_reimbursement_master",
      {
        p_company: companyId,
        p_actor: auth.userId,
        p_kind: kind,
        p_data: input,
      },
    );
    if (error)
      throw new Error(
        error.code === "23505"
          ? "This head or designation/head/start-date rule already exists. Edit it instead."
          : error.message,
      );
    revalidatePath("/master/reimbursements");
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Unable to save.",
    };
  }
}

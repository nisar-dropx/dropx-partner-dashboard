"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { booksContext } from "@/lib/finance360/server";
import { bankLedgerCode, accountKey } from "@/lib/finance/treasury/model";
export async function enrolBank(bankId: string): Promise<{
  ok: boolean;
  message: string;
}> {
  const ctx = await booksContext("add");
  if (!/^[0-9a-f-]{36}$/i.test(bankId))
    return { ok: false, message: "Select a configured bank account." };
  const { data: bank, error } = await ctx.db
    .from("payment_banks")
    .select("id,display_name,account_no,is_active")
    .eq("company_id", ctx.companyId)
    .eq("id", bankId)
    .single();
  if (error || !bank?.is_active)
    return {
      ok: false,
      message: "An active bank account in your company is required.",
    };
  const payload = {
    code: bankLedgerCode(
      bank.id,
      createHash("sha256").update(accountKey(bank.account_no)).digest("hex"),
    ),
    name: `${bank.display_name} · ${String(bank.account_no).slice(-4)}`,
    type: "asset",
    filename: "Bank enrolment",
  };
  const r = await ctx.db.rpc("finance360_write", {
    p_company: ctx.companyId,
    p_actor: ctx.authorization.userId,
    p_action: "account",
    p_data: {
      ...payload,
      sha256: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
    },
  });
  if (r.error && r.error.code !== "23505")
    return { ok: false, message: "Unable to enrol this bank. Please retry." };
  revalidatePath("/finance/treasury");
  revalidatePath("/finance/books");
  return {
    ok: true,
    message: "Bank ledger ready. Import its statement to begin reconciliation.",
  };
}
export async function recordReview(data: FormData): Promise<{
  ok: boolean;
  message: string;
}> {
  const ctx = await booksContext("edit");
  const id = String(data.get("row_id") ?? ""),
    note = String(data.get("note") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id) || note.length < 5 || note.length > 1000)
    return { ok: false, message: "Add a review note of 5–1,000 characters." };
  const row = await ctx.db
    .from("finance360_bank_rows")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("id", id)
    .single();
  if (row.error || !row.data)
    return {
      ok: false,
      message: "Bank transaction not found in your company.",
    };
  const result = await ctx.db
    .from("finance360_audit")
    .insert({
      company_id: ctx.companyId,
      actor_id: ctx.authorization.userId,
      action: "treasury_review",
      detail: { row_id: id, note },
    });
  if (result.error)
    return { ok: false, message: "Review could not be saved. Please retry." };
  revalidatePath("/finance/treasury");
  return {
    ok: true,
    message:
      "Review recorded. The exception remains open until its evidence matches.",
  };
}

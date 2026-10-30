import "server-only";
import { booksContext } from "@/lib/finance360/server";
import { canProcessPayment } from "@/lib/payment-processing-policy";
import { isCompanyOwner } from "@/lib/authorization";
import { paise, decimal, date } from "@/lib/finance360/model";
import { accountKey } from "@/lib/finance/treasury/model";
import * as XLSX from "xlsx";
type Context = Awaited<ReturnType<typeof booksContext>>;
const columns =
  "id,request_no,location_id,status,approval_status,amount,amount_requested,amount_approved,payment_mode,bank_account_no,beneficiary_account_no,beneficiary_account_number,ifsc,beneficiary_ifsc,account_holder_name,beneficiary_account_holder,payment_process_role_ids,current_approver_user_id,current_approver_role_ids";
export function eligible(ctx: Context, row: any) {
  return (
    isCompanyOwner(ctx.authorization) &&
    canProcessPayment(ctx.authorization, row, true) &&
    String(row.status).toLowerCase() !== "processing" &&
    String(row.approval_status).toLowerCase() !== "processing" &&
    (row.payment_mode ?? "account_transfer") === "account_transfer"
  );
}
function instruction(row: any) {
  const amount = paise(row.amount ?? row.amount_requested);
  if (
    amount <= BigInt(0) ||
    (row.amount_approved != null && amount > paise(row.amount_approved))
  )
    throw Error(
      "A payment exceeds its approved amount or has no payable amount.",
    );
  const account = accountKey(
    row.beneficiary_account_number ||
      row.beneficiary_account_no ||
      row.bank_account_no,
  );
  const ifsc = String(row.beneficiary_ifsc || row.ifsc || "")
    .trim()
    .toUpperCase();
  const name = String(
    row.beneficiary_account_holder || row.account_holder_name || "",
  ).trim();
  if (
    !/^\d{8,34}$/.test(account) ||
    !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) ||
    !name
  )
    throw Error("A selected payment has incomplete bank details.");
  return {
    id: row.id,
    reference: row.request_no,
    amount: decimal(amount),
    account,
    ifsc,
    name,
  };
}
export async function paymentCandidates(ctx: Context) {
  const result = await ctx.db
    .from("payment_requests")
    .select(columns)
    .eq("company_id", ctx.companyId)
    .in("status", [
      "approved",
      "Approved",
      "APPROVED",
      "owner_approved",
      "OWNER_APPROVED",
      "resubmitted",
      "Resubmitted",
      "RESUBMITTED",
    ])
    .order("id")
    .limit(501);
  if (result.error) throw Error("Unable to load approved payment requests.");
  return {
    hasMore: (result.data?.length ?? 0) > 500,
    items: (result.data ?? [])
      .slice(0, 500)
      .filter((row) => eligible(ctx, row))
      .map((row) => {
        try {
          const item = instruction(row);
          return {
            ...item,
            account: undefined,
            accountLast4: item.account.slice(-4),
            ready: true,
          };
        } catch (e) {
          return {
            id: row.id,
            reference: row.request_no,
            ready: false,
            error: e instanceof Error ? e.message : "Bank details need review.",
          };
        }
      }),
  };
}
export async function preparePaymentPlan(ctx: Context, input: any) {
  if (
    !Array.isArray(input.requestIds) ||
    !input.requestIds.length ||
    input.requestIds.length > 100 ||
    new Set(input.requestIds).size !== input.requestIds.length ||
    input.requestIds.some(
      (id: unknown) => typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id),
    )
  )
    throw Error("Select 1–100 distinct approved payment requests.");
  const valueDate = date(input.valueDate);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (valueDate < today) throw Error("Payment date cannot be in the past.");
  const [requests, bank] = await Promise.all([
    ctx.db
      .from("payment_requests")
      .select(columns)
      .eq("company_id", ctx.companyId)
      .in("id", input.requestIds),
    ctx.db
      .from("payment_banks")
      .select("id,account_no")
      .eq("company_id", ctx.companyId)
      .eq("id", input.bankId)
      .eq("is_active", true)
      .eq("bank_code", "FEDERAL_BANK")
      .single(),
  ]);
  if (requests.error || bank.error || !bank.data)
    throw Error("Unable to validate payment requests and debit account.");
  if (
    requests.data?.length !== input.requestIds.length ||
    requests.data.some((row) => !eligible(ctx, row))
  )
    throw Error(
      "Some requests are no longer approved for a new payment. Reload the queue.",
    );
  return {
    valueDate,
    debitAccount: accountKey(bank.data.account_no),
    items: requests.data.map(instruction),
  };
}
export async function validatePaymentPlan(ctx: Context, plan: any) {
  const rows = await ctx.db
    .from("payment_requests")
    .select(columns)
    .eq("company_id", ctx.companyId)
    .in(
      "id",
      plan.items.map((i: any) => i.id),
    );
  if (rows.error || rows.data?.length !== plan.items.length)
    throw Error("Payment requests changed. Do not use this checklist.");
  const bank = await ctx.db
    .from("payment_banks")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("account_no", plan.debitAccount)
    .eq("bank_code", "FEDERAL_BANK")
    .eq("is_active", true)
    .limit(1);
  if (bank.error || !bank.data?.length)
    throw Error("Debit bank account is no longer active.");
  for (const row of rows.data) {
    const expected = plan.items.find((i: any) => i.id === row.id);
    if (
      !eligible(ctx, row) ||
      JSON.stringify(instruction(row)) !== JSON.stringify(expected)
    )
      throw Error(
        "Payment approval, amount or beneficiary changed. Do not use this checklist.",
      );
  }
}
export function paymentChecklist(plan: any) {
  const rows: unknown[][] = [
    ["REVIEW CHECKLIST — NOT A BANK UPLOAD FILE"],
    ["Plan", plan.id],
    ["Value date", plan.valueDate],
    ["Debit account", plan.debitAccount],
    ["Total INR", plan.total],
    ["Request", "Beneficiary", "Account", "IFSC", "Amount INR"],
    ...plan.items.map((i: any) => [
      i.reference,
      i.name,
      i.account,
      i.ifsc,
      i.amount,
    ]),
  ];
  // String cells preserve account leading zeros and do not execute formula-like names.
  const sheet = XLSX.utils.aoa_to_sheet(
    rows.map((row) => row.map((value) => String(value ?? ""))),
  );
  sheet["!cols"] = [
    { wch: 42 },
    { wch: 40 },
    { wch: 28 },
    { wch: 18 },
    { wch: 18 },
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Review checklist");
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

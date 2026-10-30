import "server-only";
import { createHash } from "node:crypto";
import { booksContext } from "@/lib/finance360/server";
import {
  accountKey,
  bankLedgerCode,
  reconcile,
  type Payout,
  type Transaction,
} from "./model";
type Context = Awaited<ReturnType<typeof booksContext>>;
type Row = Record<string, any>;
const scopeLimit = 30000;
async function all(
  ctx: Context,
  table: string,
  columns: string,
  order = "id",
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset <= scopeLimit; offset += 1000) {
    const r = await ctx.db
      .from(table)
      .select(columns)
      .eq("company_id", ctx.companyId)
      .order(order)
      .range(offset, offset + 999);
    if (r.error)
      throw new Error(
        `Unable to load ${table.replaceAll("_", " ")}. Reconciliation is unavailable until all sources can be read.`,
      );
    rows.push(...(r.data as unknown as Row[]));
    if (rows.length > scopeLimit)
      throw new Error(
        "Reconciliation exceeds the supported company data size. No partial totals have been shown.",
      );
    if ((r.data ?? []).length < 1000) return rows;
  }
  return rows;
}
function indiaDate(value: unknown) {
  if (!value) return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d)
    : null;
}
export async function loadTreasury(ctx: Context) {
  const [
    banks,
    accounts,
    statements,
    rows,
    requests,
    payroll,
    workforce,
    helpers,
    workforceBatches,
    helperBatches,
    cashbook,
  ] = await Promise.all([
    all(ctx, "payment_banks", "id,display_name,bank_code,account_no,is_active"),
    all(ctx, "finance360_accounts", "code,name,type", "code"),
    all(
      ctx,
      "finance360_bank_statements",
      "id,account_code,period_start,period_end,opening,closing",
    ),
    all(
      ctx,
      "finance360_bank_rows",
      "id,statement_id,date,description,reference,debit,credit,balance,matched_line_id",
    ),
    all(
      ctx,
      "payment_requests",
      "id,request_no,status,amount,amount_requested,amount_approved,utr_cin,utr,processed_at,paid_at",
    ),
    all(
      ctx,
      "hr_payroll_bank_lines",
      "id,reference,amount,status,utr,debit_account_number,value_date,updated_at",
    ),
    all(
      ctx,
      "workforce_payout_payment_items",
      "id,batch_id,reference_no,instruction_amount,status,utr_cin,response_debit_account_no,response_value_date,finalized_at",
    ),
    all(
      ctx,
      "helper_payout_payment_items",
      "id,batch_id,reference_no,instruction_amount,status,utr_cin,response_debit_account_no,response_value_date,finalized_at",
    ),
    all(
      ctx,
      "workforce_payout_payment_batches",
      "id,debit_account_no_snapshot",
    ),
    all(ctx, "helper_payout_payment_batches", "id,debit_account_no_snapshot"),
    all(
      ctx,
      "cps_cashbook_daily",
      "id,expense_date,station_code,amount,remarks,raw_payload,created_at",
    ),
  ]);
  const payout = (
    source: Payout["source"],
    r: Row,
    amount: unknown,
    utr: unknown,
    reference: unknown,
    bank: unknown,
    date: unknown,
    approved: unknown = null,
  ): Payout => ({
    key: `${source}:${r.id}`,
    source,
    reference: String(reference ?? r.id),
    amount: String(amount ?? "0"),
    approvedAmount: approved == null ? null : String(approved),
    utr: String(utr ?? ""),
    status: String(r.status ?? ""),
    paidDate: indiaDate(date),
    debitAccount: accountKey(bank),
  });
  const wb = new Map(
      workforceBatches.map((b) => [b.id, b.debit_account_no_snapshot]),
    ),
    hb = new Map(helperBatches.map((b) => [b.id, b.debit_account_no_snapshot]));
  const payouts = [
    ...requests.map((r) =>
      payout(
        "requests",
        r,
        r.amount ?? r.amount_requested,
        r.utr_cin || r.utr,
        r.request_no,
        "",
        r.processed_at || r.paid_at,
        r.amount_approved,
      ),
    ),
    ...payroll.map((r) =>
      payout(
        "payroll",
        r,
        r.amount,
        r.utr,
        r.reference,
        r.debit_account_number,
        r.value_date || r.updated_at,
      ),
    ),
    ...workforce.map((r) =>
      payout(
        "workforce",
        r,
        r.instruction_amount,
        r.utr_cin,
        r.reference_no,
        r.response_debit_account_no || wb.get(r.batch_id),
        r.response_value_date || r.finalized_at,
      ),
    ),
    ...helpers.map((r) =>
      payout(
        "helpers",
        r,
        r.instruction_amount,
        r.utr_cin,
        r.reference_no,
        r.response_debit_account_no || hb.get(r.batch_id),
        r.response_value_date || r.finalized_at,
      ),
    ),
  ];
  const byStatement = new Map(statements.map((s) => [s.id, s])),
    bankAccounts = new Map(
      banks.map((b) => [
        bankLedgerCode(
          b.id,
          createHash("sha256").update(accountKey(b.account_no)).digest("hex"),
        ),
        accountKey(b.account_no),
      ]),
    );
  const transactions: Transaction[] = rows.map(
    (r) =>
      ({
        ...r,
        account_code: byStatement.get(r.statement_id)?.account_code ?? "",
        bankAccount:
          bankAccounts.get(byStatement.get(r.statement_id)?.account_code) ?? "",
        debit: String(r.debit),
        credit: String(r.credit),
        balance: String(r.balance),
      }) as Transaction,
  );
  const findings = reconcile(transactions, payouts);
  const audit = await ctx.db
    .from("finance360_audit")
    .select("id,detail,created_at")
    .eq("company_id", ctx.companyId)
    .eq("action", "treasury_review")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (audit.error)
    throw new Error(
      "Unable to load reconciliation review history. Please retry.",
    );
  // Only masked bank identities and payout references leave this server boundary.
  return {
    banks: banks.map((b) => ({
      id: String(b.id),
      name: String(b.display_name),
      code: bankLedgerCode(
        b.id,
        createHash("sha256").update(accountKey(b.account_no)).digest("hex"),
      ),
      last4: String(b.account_no).slice(-4),
      active: Boolean(b.is_active),
      enrolled: accounts.some(
        (a) =>
          a.code ===
          bankLedgerCode(
            b.id,
            createHash("sha256").update(accountKey(b.account_no)).digest("hex"),
          ),
      ),
    })),
    accounts: accounts
      .filter((a) => ["asset", "liability"].includes(a.type))
      .map((a) => ({
        code: String(a.code),
        name: String(a.name),
        type: String(a.type),
      })),
    statements: statements.map((s) => ({
      id: String(s.id),
      account_code: String(s.account_code),
      period_start: String(s.period_start),
      period_end: String(s.period_end),
      opening: String(s.opening),
      closing: String(s.closing),
    })),
    reviews: (audit.data ?? []).map((r) => ({
      id: String(r.id),
      rowId: String(r.detail?.row_id ?? ""),
      note: String(r.detail?.note ?? ""),
      date: String(r.created_at),
    })),
    findings: findings.map((f) => ({
      ...f,
      bank: { ...f.bank, bankAccount: "" },
      payout: f.payout ? { ...f.payout, debitAccount: "" } : null,
    })),
    payouts: payouts.map((p) => ({ ...p, debitAccount: "" })),
    cashbook: cashbook.map((r) => ({
      id: String(r.id),
      date: String(r.expense_date),
      station: String(r.station_code ?? ""),
      amount: String(r.amount),
      reference: String(
        r.raw_payload?.["UPI Ref No"] ?? r.raw_payload?.["Txn Id"] ?? "",
      ),
      note: String(r.remarks ?? ""),
      importedAt: String(r.created_at),
    })),
    readAt: new Date().toISOString(),
  };
}
export type Treasury = Awaited<ReturnType<typeof loadTreasury>>;

import { paise, decimal } from "../../finance360/model";
export type Payout = {
  key: string;
  source: "requests" | "payroll" | "workforce" | "helpers";
  reference: string;
  amount: string;
  approvedAmount: string | null;
  utr: string;
  status: string;
  paidDate: string | null;
  debitAccount: string;
};
export type Transaction = {
  id: string;
  statement_id: string;
  account_code: string;
  bankAccount: string;
  date: string;
  description: string;
  reference: string;
  debit: string;
  credit: string;
  balance: string;
  matched_line_id: string | null;
};
export const outcomes = {
  matched: "Settlement matched",
  missing_reference: "Bank reference missing",
  unexplained: "No payout found",
  duplicate: "Duplicate reference — review",
  excess: "Debit exceeds payout",
  short: "Debit below payout",
  bank_mismatch: "Different debit account",
  bank_unknown: "Debit account unverified",
  status_mismatch: "Payout not recorded as paid",
  date_mismatch: "Payment dates differ",
  incoming: "Receipt / transfer to classify",
  invalid: "Invalid payout amount",
} as const;
export type Outcome = keyof typeof outcomes;
export type Finding = {
  bank: Transaction;
  outcome: Outcome;
  payout: Payout | null;
  candidates: string[];
  difference: string | null;
};
export const referenceKey = (v: unknown) => {
  const key = String(v ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return [
    "NA",
    "N/A",
    "NULL",
    "NONE",
    "0",
    "CASH",
    "TRANSFER",
    "BANK",
    "-",
  ].includes(key)
    ? ""
    : key;
};
export const accountKey = (v: unknown) => String(v ?? "").replace(/[\s-]/g, "");
export const paid = (v: string) =>
  ["paid", "processed"].includes(v.toLowerCase());
export function bankLedgerCode(bankId: string, accountFingerprint: string) {
  return `BANK-${bankId}-${accountFingerprint.slice(0, 24)}`;
}
/** One bank debit and one paid instruction are required; amount-only guesses never clear a debit. */
export function reconcile(
  transactions: Transaction[],
  payouts: Payout[],
): Finding[] {
  const sources = new Map<string, Payout[]>(),
    bankRefs = new Map<string, number>();
  for (const p of payouts) {
    const ref = referenceKey(p.utr);
    if (ref) sources.set(ref, [...(sources.get(ref) ?? []), p]);
  }
  for (const b of transactions) {
    const ref = referenceKey(b.reference);
    if (ref && paise(b.debit) > BigInt(0))
      bankRefs.set(ref, (bankRefs.get(ref) ?? 0) + 1);
  }
  return transactions.map((bank) => {
    const ref = referenceKey(bank.reference),
      candidates = sources.get(ref) ?? [];
    const payout = candidates.length === 1 ? candidates[0] : null;
    const finding = (
      outcome: Outcome,
      difference: string | null = null,
    ): Finding => ({
      bank,
      payout,
      candidates: candidates.map((p) => p.key),
      outcome,
      difference,
    });
    if (paise(bank.credit) > BigInt(0)) return finding("incoming");
    if (!ref) return finding("missing_reference");
    if ((bankRefs.get(ref) ?? 0) > 1 || candidates.length > 1)
      return finding("duplicate");
    if (!payout) return finding("unexplained");
    let expected: bigint, approved: bigint | null;
    try {
      expected = paise(payout.amount);
      approved =
        payout.approvedAmount == null ? null : paise(payout.approvedAmount);
    } catch {
      return finding("invalid");
    }
    if (expected <= BigInt(0)) return finding("invalid");
    const debit = paise(bank.debit),
      ceiling = approved == null || approved > expected ? expected : approved;
    if (debit > ceiling) return finding("excess", decimal(debit - ceiling));
    if (debit < expected) return finding("short", decimal(debit - expected));
    if (!paid(payout.status)) return finding("status_mismatch");
    if (!bank.bankAccount || !payout.debitAccount)
      return finding("bank_unknown");
    if (accountKey(bank.bankAccount) !== accountKey(payout.debitAccount))
      return finding("bank_mismatch");
    const days = payout.paidDate
      ? Math.abs(Date.parse(bank.date) - Date.parse(payout.paidDate)) / 86400000
      : Infinity;
    if (!Number.isFinite(days) || days > 7) return finding("date_mismatch");
    return finding("matched");
  });
}
export function statementDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (!Number.isInteger(value) || value < 25569 || value > 100000)
      throw new Error("Invalid Excel transaction date.");
    return new Date((value - 25569) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) throw new Error("Use dates as DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD.");
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
export type Mapping = {
  date: number;
  description: number;
  reference: number;
  debit: number;
  credit: number;
  balance: number;
};
export function mappedRows(
  matrix: unknown[][],
  header: number,
  mapping: Mapping,
) {
  const selected = Object.values(mapping);
  if (
    selected.some((i) => !Number.isInteger(i) || i < 0) ||
    new Set(selected).size !== selected.length
  )
    throw new Error("Select six different statement columns.");
  const rows = matrix
    .slice(header + 1)
    .filter((r) => r.some((v) => v != null && String(v).trim()));
  if (!rows.length || rows.length > 5000)
    throw new Error("Import 1–5,000 transactions at a time.");
  return rows.map((r, i) => {
    if (r[mapping.balance] == null || String(r[mapping.balance]).trim() === "")
      throw new Error(`Row ${i + header + 2}: running balance is required.`);
    return {
      date: statementDate(r[mapping.date]),
      description: String(r[mapping.description] ?? ""),
      reference: String(r[mapping.reference] ?? ""),
      debit: r[mapping.debit] ?? "",
      credit: r[mapping.credit] ?? "",
      balance: r[mapping.balance],
    };
  });
}

export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type SheetRow = Record<string, unknown>;
export type EntryLine = {
  code: string;
  name: string;
  type: AccountType;
  debit: string;
  credit: string;
};
export type Voucher = {
  reference: string;
  date: string;
  narration: string;
  lines: EntryLine[];
};
export type BankRow = {
  date: string;
  description: string;
  reference: string;
  debit: string;
  credit: string;
  balance: string;
};
export type TrialRow = {
  code: string;
  name: string;
  type: AccountType;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
};
export function date(value: unknown): string {
  const s = String(value ?? "").trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(`${s}T00:00:00Z`)) ||
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s
  )
    throw new Error(`Use a valid YYYY-MM-DD date: ${s.slice(0, 30)}`);
  return s;
}
export function paise(value: unknown, signed = false): bigint {
  const s = String(value ?? "")
    .trim()
    .replaceAll(",", "");
  if (!s) return BigInt(0);
  if (!(signed ? /^-?\d{1,13}(\.\d{1,2})?$/ : /^\d{1,13}(\.\d{1,2})?$/).test(s))
    throw new Error(
      `Invalid amount: ${s.slice(0, 30)}. Use up to two decimal places.`,
    );
  const [whole, fraction = ""] = s.replace("-", "").split(".");
  const n = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return s.startsWith("-") ? -n : n;
}
export function decimal(n: bigint) {
  return `${n < BigInt(0) ? "-" : ""}${(n < BigInt(0) ? -n : n) / BigInt(100)}.${((n < BigInt(0) ? -n : n) % BigInt(100)).toString().padStart(2, "0")}`;
}
export function money(value: string | bigint) {
  const n = typeof value === "bigint" ? value : paise(value, true);
  const [whole, fraction] = decimal(n).split(".");
  return `${n < BigInt(0) ? "−" : ""}₹${BigInt(whole.replace("-", "")).toLocaleString("en-IN")}.${fraction}`;
}
function text(value: unknown, label: string, max = 200) {
  const s = String(value ?? "").trim();
  if (!s || s.length > max)
    throw new Error(`${label} is required (maximum ${max} characters).`);
  return s;
}
export function parseJournals(rows: SheetRow[]): Voucher[] {
  if (!rows.length || rows.length > 5000)
    throw new Error("Upload 1–5,000 journal lines per file.");
  const vouchers = new Map<string, Voucher>();
  const accounts = new Map<string, string>();
  rows.forEach((row, index) => {
    try {
      const reference = text(row.reference, "reference", 150);
      const postingDate = date(row.date);
      const code = text(row.account_code, "account_code", 80);
      const name = text(row.account_name, "account_name");
      const type = String(row.account_type).trim().toLowerCase() as AccountType;
      if (!ACCOUNT_TYPES.includes(type))
        throw new Error(
          "account_type must be asset, liability, equity, income or expense.",
        );
      const signature = JSON.stringify([name, type]);
      if (accounts.has(code) && accounts.get(code) !== signature)
        throw new Error(`Conflicting account details for ${code}.`);
      accounts.set(code, signature);
      const dr = paise(row.debit),
        cr = paise(row.credit);
      if (dr > BigInt(0) === cr > BigInt(0))
        throw new Error(
          "Each line needs either a debit or a credit, not both.",
        );
      const narration = text(row.narration, "narration", 1000);
      let voucher = vouchers.get(reference);
      if (!voucher) {
        voucher = { reference, date: postingDate, narration, lines: [] };
        vouchers.set(reference, voucher);
      }
      if (voucher.date !== postingDate || voucher.narration !== narration)
        throw new Error(
          `Reference ${reference} has inconsistent date or narration.`,
        );
      voucher.lines.push({
        code,
        name,
        type,
        debit: decimal(dr),
        credit: decimal(cr),
      });
    } catch (error) {
      throw new Error(`Row ${index + 2}: ${(error as Error).message}`);
    }
  });
  for (const v of vouchers.values()) {
    if (
      v.lines.length < 2 ||
      v.lines.reduce(
        (s, l) => s + paise(l.debit) - paise(l.credit),
        BigInt(0),
      ) !== BigInt(0)
    )
      throw new Error(
        `Voucher ${v.reference} does not balance. Nothing has been posted.`,
      );
  }
  return [...vouchers.values()];
}
export function parseBank(
  rows: SheetRow[],
  opening: unknown,
  closing: unknown,
  start: string,
  end: string,
): BankRow[] {
  date(start);
  date(end);
  if (start > end)
    throw new Error("Statement start must be on or before its end date.");
  if (!rows.length || rows.length > 5000)
    throw new Error("Upload 1–5,000 bank transactions per file.");
  let balance = paise(opening, true),
    previous = start;
  const result = rows.map((row, index) => {
    try {
      const d = date(row.date);
      if (d < previous || d > end)
        throw new Error(
          "Dates must be in ascending order, within the statement period.",
        );
      previous = d;
      const debit = paise(row.debit),
        credit = paise(row.credit);
      if (debit > BigInt(0) === credit > BigInt(0))
        throw new Error("Use either debit (money out) or credit (money in).");
      balance += credit - debit;
      if (
        row.balance != null &&
        String(row.balance).trim() !== "" &&
        paise(row.balance, true) !== balance
      )
        throw new Error(
          "Running balance does not reconcile to the preceding row.",
        );
      return {
        date: d,
        description: text(row.description, "description", 1000),
        reference: String(row.reference ?? "")
          .trim()
          .slice(0, 150),
        debit: decimal(debit),
        credit: decimal(credit),
        balance: decimal(balance),
      };
    } catch (error) {
      throw new Error(`Row ${index + 2}: ${(error as Error).message}`);
    }
  });
  if (balance !== paise(closing, true))
    throw new Error(
      "Opening balance + credits − debits does not equal the closing balance. Nothing has been imported.",
    );
  return result;
}
export function statements(rows: TrialRow[]) {
  let income = BigInt(0),
    expenses = BigInt(0),
    assets = BigInt(0),
    liabilities = BigInt(0),
    equity = BigInt(0),
    accumulatedProfit = BigInt(0),
    difference = BigInt(0);
  for (const r of rows) {
    const closing = paise(r.closing, true),
      net = paise(r.debit) - paise(r.credit);
    difference += closing;
    if (r.type === "income") {
      income -= net;
      accumulatedProfit -= closing;
    }
    if (r.type === "expense") {
      expenses += net;
      accumulatedProfit -= closing;
    }
    if (r.type === "asset") assets += closing;
    if (r.type === "liability") liabilities -= closing;
    if (r.type === "equity") equity -= closing;
  }
  return {
    income,
    expenses,
    profit: income - expenses,
    assets,
    liabilities,
    equity,
    accumulatedProfit,
    difference,
    balanceDifference: assets - liabilities - equity - accumulatedProfit,
  };
}
export function csvCell(value: unknown) {
  const s = String(value ?? "");
  return `"${(/^[=+@\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""')}"`;
}

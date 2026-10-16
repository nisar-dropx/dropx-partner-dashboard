// Integer paise throughout. A bank transaction ID is not a unique statement row.
export function money(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/,/g, "");
  if (!/^-?\d{1,14}(?:\.\d{1,2})?$/.test(text))
    throw Error("Invalid statement amount.");
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -amount : amount;
}
export function decimal(amount) {
  const negative = amount < 0n;
  const n = negative ? -amount : amount;
  return `${negative ? "-" : ""}${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}
export function date(value) {
  const s = String(value ?? "").trim();
  const parts = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : s;
  if (
    !/^20\d{2}-\d{2}-\d{2}$/.test(iso) ||
    new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso
  )
    throw Error("Invalid statement date.");
  return iso;
}
export async function digest(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
function text(value, limit) {
  const s = String(value ?? "").trim();
  if (s.length > limit)
    throw Error("Statement field exceeds the supported length.");
  return s;
}
// Only explicit bank reference patterns are extracted. S-prefixed ledger transaction
// IDs must not be substituted for NEFT/RTGS/IMPS UTRs.
export function reference(narration) {
  return (
    /(?:^|\/)(?:NFT|NEFT|RTGS|IMPS)\/([A-Z0-9]{8,35})(?:\/|$)/i
      .exec(narration)?.[1]
      ?.toUpperCase() ?? ""
  );
}
export async function normalizeStatement(input) {
  const account = text(input.account, 34).replace(/\s/g, "");
  if (!/^\d{8,34}$/.test(account))
    throw Error("A complete bank account number is required.");
  const start = date(input.start),
    end = date(input.end);
  if (start > end) throw Error("Invalid statement period.");
  if (
    input.complete !== true ||
    !Array.isArray(input.rows) ||
    input.total !== input.rows.length
  )
    throw Error("Incomplete bank statement; nothing was imported.");
  if (!input.rows.length || input.rows.length > 5000)
    throw Error("Choose a period with 1–5,000 transactions.");
  const rows = input.rows.map((r, i) => {
    if (
      !Array.isArray(r) ||
      r.length !== 8 ||
      Number(String(r[0]).replace(/,/g, "")) !== i + 1
    )
      throw Error("Statement row sequence changed; collect it again.");
    const day = date(r[1]);
    if (day < start || day > end)
      throw Error("Statement contains a date outside the requested period.");
    const amount = money(r[6]),
      balance = money(r[7]);
    const side = String(r[5]).trim().toLowerCase();
    if (amount <= 0n || !["dr.", "cr.", "dr", "cr"].includes(side))
      throw Error("Invalid bank debit/credit direction.");
    const description = text(r[3], 1000);
    return {
      date: day,
      transactionId: text(r[2], 100),
      description,
      cheque: text(r[4], 100),
      reference: reference(description),
      debit: decimal(side.startsWith("dr") ? amount : 0n),
      credit: decimal(side.startsWith("cr") ? amount : 0n),
      balance: decimal(balance),
    };
  });
  // FedNet presents newest first, including the sequence within each day. Reverse
  // the entire sequence, never sort by transaction ID or by date alone.
  rows.reverse();
  let previous = start;
  let running =
    money(rows[0].balance) + money(rows[0].debit) - money(rows[0].credit);
  const opening = decimal(running);
  const identities = new Set();
  for (const row of rows) {
    if (row.date < previous)
      throw Error("Statement must be ordered newest first.");
    previous = row.date;
    running += money(row.credit) - money(row.debit);
    if (running !== money(row.balance))
      throw Error(
        "Running balance does not reconcile; the statement may be incomplete.",
      );
    row.fingerprint = await digest(
      JSON.stringify([
        account,
        row.date,
        row.transactionId,
        row.description,
        row.cheque,
        row.debit,
        row.credit,
        row.balance,
      ]),
    );
    if (identities.has(row.fingerprint))
      throw Error("Indistinguishable duplicate bank rows require review.");
    identities.add(row.fingerprint);
  }
  const result = {
    account,
    start,
    end,
    opening,
    closing: decimal(running),
    rows,
  };
  return {
    ...result,
    sha256: await digest(JSON.stringify(result)),
    capturedAt: new Date().toISOString(),
  };
}

/** Column layout and cell rules shared by the recovery workbook download and upload. */
export const WORKBOOK_SHEET = "Cases";
/** Read-only columns identify the case; the upload matches on Case ref + Version. */
export const WORKBOOK_COLUMNS = [
  "Case ref",
  "Version",
  "Month",
  "Period",
  "Station",
  "TID",
  "Loss reason",
  "Sub reason",
  "Amazon decision",
  "Loss amount",
  "Current action",
  "Recovery action",
  "Employee IDs",
  "Remarks",
  "Re-dispute reason",
  "Detailing",
  "CCTV link",
  "CCTV link is public (Yes/No)",
] as const;
export type WorkbookColumn = (typeof WORKBOOK_COLUMNS)[number];
export const WORKBOOK_FILL_FROM = WORKBOOK_COLUMNS.indexOf("Recovery action");
export const WORKBOOK_MAX_ROWS = 2000;
export const caseRef = (month: string, caseKey: string) => `${month}::${caseKey}`;
export function parseCaseRef(ref: string) {
  const at = ref.indexOf("::");
  if (at < 0) return null;
  const month = ref.slice(0, at),
    case_key = ref.slice(at + 2);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && case_key && case_key.length <= 300
    ? { month, case_key }
    : null;
}

export type AllocationCell =
  | { mode: "none"; people: []; error?: undefined }
  | { mode: "equal"; people: { code: string }[]; error?: undefined }
  | { mode: "custom"; people: { code: string; amount: number }[]; error?: undefined }
  | { mode: "error"; people: []; error: string };

/**
 * "D0123, D0456" splits the loss equally; "D0123=500, D0456=449" sets each amount.
 * Mixing the two is rejected so an amount is never guessed.
 */
export function parseAllocationCell(value: unknown): AllocationCell {
  const tokens = String(value ?? "")
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return { mode: "none", people: [] };
  const fail = (error: string): AllocationCell => ({ mode: "error", people: [], error });
  const parsed = tokens.map((token) => {
    const [code, amount, ...rest] = token.split("=").map((p) => p.trim());
    return { code: (code ?? "").toUpperCase(), amount, extra: rest.length > 0 };
  });
  if (parsed.some((p) => !p.code || p.extra || p.code.length > 40))
    return fail("Employee IDs must look like D0123 or D0123=500.");
  if (new Set(parsed.map((p) => p.code)).size !== parsed.length)
    return fail("An employee can be listed only once per case.");
  if (parsed.length > 50) return fail("Select up to 50 employees.");
  const withAmount = parsed.filter((p) => p.amount !== undefined);
  if (!withAmount.length)
    return { mode: "equal", people: parsed.map((p) => ({ code: p.code })) };
  if (withAmount.length !== parsed.length)
    return fail("Give an amount for every employee, or for none to split equally.");
  if (withAmount.some((p) => !/^\d+(\.\d{1,2})?$/.test(p.amount!) || Number(p.amount) <= 0))
    return fail("Enter each amount as a positive number with at most two decimals.");
  return {
    mode: "custom",
    people: parsed.map((p) => ({ code: p.code, amount: Number(p.amount) })),
  };
}

/** An action is typed (or pasted) as its label; the code is accepted too. Removed actions never match. */
export function matchOutcome<T extends { code: string; label: string; is_active: boolean }>(
  value: unknown,
  outcomes: T[],
): T | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  return (
    outcomes.find(
      (o) => o.is_active && (o.label.trim().toLowerCase() === text || o.code === text),
    ) ?? null
  );
}

export const yes = (value: unknown) =>
  ["yes", "y", "true", "1"].includes(String(value ?? "").trim().toLowerCase());

export type AuditEmployee = {
  ref: string;
  employee_code: string;
  full_name: string;
  designation: string;
  is_active: boolean;
};
export type ShipmentLists = {
  expected: string[];
  scanned: string[];
  remarks: Record<string, string>;
};
/** Only a TID column is accepted, so report headers or other cells cannot silently become shipments. */
export function parseAuditTids(raw: string) {
  if (raw.length > 1500000)
    throw new Error("TID list is too large. Maximum 10,000 unique TIDs.");
  const tokens = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const invalid = tokens.find(
    (t) => !/^(?=.*\d)[A-Z0-9][A-Z0-9_-]{3,79}$/.test(t),
  );
  if (invalid)
    throw new Error(
      `Invalid TID “${invalid.slice(0, 80)}”. Paste only the tracking-ID column, without its header.`,
    );
  const ids = [...new Set(tokens)];
  if (ids.length > 10000)
    throw new Error("Maximum 10,000 unique TIDs per list.");
  return { ids, duplicates: tokens.length - ids.length };
}
const sheetTid = /^(?=.*\d)[A-Z0-9][A-Z0-9_-]{3,79}$/;
const tidHeading = /track|\btid\b|awb|waybill|shipment|consignment|barcode/i;
const reasonHeading = /reason|remark|observation|comment|note/i;
// A number too large to be exact is kept as written by Excel (1.2e+21), which is
// not a tracking ID, so the row is counted as skipped instead of being guessed.
const sheetCell = (value: unknown) => String(value ?? "").trim();
export type AuditTidSheet = {
  ids: string[];
  /** Reason typed next to a tracking ID, when the sheet has such a column. */
  reasons: Record<string, string>;
  duplicates: number;
  /** Rows whose tracking-ID cell was filled but is not a tracking ID. */
  skipped: number;
  hasReasons: boolean;
};
/**
 * Reads tracking IDs, and reasons where given, from the rows of a spreadsheet.
 * The tracking-ID column is found by its heading; a sheet without headings uses
 * the column that holds the most tracking IDs.
 */
export function readAuditTidSheet(rows: unknown[][]): AuditTidSheet {
  const cells = rows.map((row) => (Array.isArray(row) ? row.map(sheetCell) : []));
  const tidsBelow = (from: number, column: number) =>
    cells
      .slice(from, from + 500)
      .filter((row) => sheetTid.test((row[column] || "").toUpperCase())).length;
  let start = 0,
    tidColumn = -1,
    reasonColumn = -1,
    best = 0;
  // A heading counts only when tracking IDs sit beneath it, so a report title
  // or a "Shipment status" column is never mistaken for the tracking-ID column.
  for (let index = 0; index < Math.min(cells.length, 20); index++)
    cells[index].forEach((cell, column) => {
      if (!tidHeading.test(cell) || sheetTid.test(cell.toUpperCase())) return;
      const found = tidsBelow(index + 1, column);
      if (found <= best) return;
      best = found;
      tidColumn = column;
      start = index + 1;
      reasonColumn = cells[index].findIndex(
        (other, at) => at !== column && reasonHeading.test(other),
      );
    });
  if (tidColumn < 0) {
    const width = Math.max(0, ...cells.slice(0, 500).map((row) => row.length));
    for (let column = 0; column < width; column++) {
      const found = tidsBelow(0, column);
      if (found > best) {
        best = found;
        tidColumn = column;
      }
    }
  }
  if (tidColumn < 0)
    throw new Error(
      "No tracking IDs found in this file. Keep them in one column under a heading such as Tracking ID.",
    );
  const ids = new Set<string>();
  const reasons: Record<string, string> = {};
  let duplicates = 0,
    skipped = 0;
  for (const row of cells.slice(start)) {
    const tid = (row[tidColumn] || "").toUpperCase();
    if (!tid) continue;
    if (!sheetTid.test(tid)) {
      skipped += 1;
      continue;
    }
    if (ids.has(tid)) duplicates += 1;
    ids.add(tid);
    const reason = reasonColumn < 0 ? "" : (row[reasonColumn] || "").slice(0, 300);
    if (reason) reasons[tid] = reason;
  }
  if (ids.size > 10000) throw new Error("Maximum 10,000 unique TIDs per list.");
  return { ids: [...ids], reasons, duplicates, skipped, hasReasons: reasonColumn >= 0 };
}
export type AuditSheet = { name: string; rows: string[][]; widths: number[] };
/** Sheets that explain or illustrate; an upload never reads tracking IDs from them. */
export const auditHelpSheet = /^(column guide|sample|how to use)$/i;
const columnGuide: AuditSheet = {
  name: "Column guide",
  widths: [16, 78, 12, 34],
  rows: [
    ["Column", "What to enter", "Required", "Example"],
    [
      "Tracking ID",
      "The shipment's tracking ID exactly as printed on the label or shown in the ERP ageing report. One shipment per row. Letters, digits, hyphen and underscore only, 4 to 80 characters, with at least one digit.",
      "Yes",
      "TBA123456789",
    ],
    [
      "Reason",
      "The auditor's observation for that shipment: what was found and why it is missing or extra. Up to 300 characters. It is used only when the shipment turns out to be missing or excess.",
      "No",
      "Not on shelf; last scanned 11 Oct",
    ],
    [
      "Type",
      "Appears only in the Differences download. Missing = in the ERP ageing list but not physically scanned. Excess = physically scanned but not in the ERP ageing list. Filled by the portal; do not change it.",
      "Filled for you",
      "Missing",
    ],
    [],
    ["Where to upload", "What the file should hold"],
    [
      "ERP ageing",
      "Every shipment the system says is at the station. Use the ERP ageing report or this template.",
    ],
    [
      "Physically scanned",
      "Every shipment actually found and scanned at the station.",
    ],
    [
      "Upload reasons",
      "The Differences download with its Reason column completed. Only reasons for listed differences are taken.",
    ],
    [],
    ["Rules"],
    ["Keep the headings in row 1 of the Tracking IDs sheet. Other columns are ignored."],
    ["Up to 10,000 tracking IDs per list. A repeated tracking ID counts once."],
    ["A row whose Tracking ID is not a tracking ID is skipped and reported after upload."],
    ["Uploading adds to the list already on screen; it does not replace it."],
    ["The Column guide and Sample sheets are never read. Enter your data in the first sheet."],
  ],
};
/** The fill-in template: an empty sheet to complete, what each column means, and a filled example. */
export function auditTidTemplate(): AuditSheet[] {
  return [
    { name: "Tracking IDs", widths: [26, 60], rows: [["Tracking ID", "Reason"]] },
    columnGuide,
    {
      name: "Sample",
      widths: [26, 60],
      rows: [
        ["Tracking ID", "Reason"],
        ["TBA123456789", "Not on shelf; last scanned 11 Oct"],
        ["363912345678", ""],
        ["TBA987654321", "Damaged, kept aside for return"],
        ["AWB-55001234", "Found at station, not in ageing report"],
      ],
    },
  ];
}
/** Missing and excess shipments with their observations, ready to complete and upload back. */
export function auditDifferencesWorkbook(
  rows: { tid: string; kind: string; reason: string }[],
): AuditSheet[] {
  return [
    {
      name: "Differences",
      widths: [26, 10, 60],
      rows: [
        ["Tracking ID", "Type", "Reason"],
        ...rows.map((row) => [row.tid, row.kind, row.reason]),
      ],
    },
    columnGuide,
  ];
}
export function compareAuditTids(expected: string[], scanned: string[]) {
  const a = new Set(expected),
    b = new Set(scanned);
  return {
    missing: [...a].filter((t) => !b.has(t)),
    excess: [...b].filter((t) => !a.has(t)),
    matched: [...a].filter((t) => b.has(t)).length,
  };
}
export function selectedAuditEmployees(
  refs: string[],
  people: AuditEmployee[],
) {
  const unique = [...new Set(refs.filter(Boolean))];
  if (unique.length > 25) throw new Error("Select up to 25 employees.");
  return unique.map((ref) => {
    const person = people.find((p) => p.ref === ref);
    if (!person)
      throw new Error(
        "Selected employee is no longer linked to this station. Refresh and select again.",
      );
    return person;
  });
}

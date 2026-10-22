export type CentralBankResponseCategory = "reconciled" | "exceptions" | "skipped";

export type CentralBankResponseDetail = {
  ledger: string;
  message: string;
  outcome: string;
  referenceNo: string;
  rowNumber: number;
};

export type CentralBankResponseIssue = {
  category: Exclude<CentralBankResponseCategory, "reconciled">;
  message: string;
  referenceNo: string;
  rowNumber: number;
};

export type CentralBankResponseGroups = Record<CentralBankResponseCategory, CentralBankResponseDetail[]>;

type SummaryInput = {
  databaseRows: unknown;
  issues: CentralBankResponseIssue[];
  replayedFile: boolean;
  replayedRowNumbers?: unknown;
};

const RECONCILED_OUTCOMES = new Set(["paid", "cancelled", "failed"]);

function boundedText(value: unknown, fallback: string, maximumLength = 500) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, maximumLength);
}

function safeRowNumber(value: unknown) {
  const rowNumber = Number(value);
  return Number.isSafeInteger(rowNumber) && rowNumber > 0 ? rowNumber : null;
}

function replayedRows(value: unknown) {
  const result = new Set<number>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    const rowNumber = safeRowNumber(item);
    if (rowNumber) result.add(rowNumber);
  }
  return result;
}

function categoryForOutcome(outcome: string, replayed: boolean): CentralBankResponseCategory {
  if (replayed) return "skipped";
  if (RECONCILED_OUTCOMES.has(outcome)) return "reconciled";
  if (outcome === "rejected") return "exceptions";
  if (outcome === "replayed" || outcome === "unknown") return "skipped";
  return "exceptions";
}

function outcomeLabel(outcome: string, replayed: boolean) {
  if (replayed || outcome === "replayed") return "Already finalized";
  if (outcome === "paid") return "Paid";
  if (outcome === "cancelled") return "Cancelled";
  if (outcome === "failed") return "Failed";
  if (outcome === "rejected") return "Exception";
  if (outcome === "unknown") return "Skipped";
  return "Exception";
}

function issueDetail(issue: CentralBankResponseIssue): CentralBankResponseDetail | null {
  const rowNumber = safeRowNumber(issue.rowNumber);
  if (!rowNumber) return null;
  return {
    ledger: "",
    message: boundedText(issue.message, "This bank response row could not be processed safely."),
    outcome: issue.category === "exceptions" ? "Exception" : "Skipped",
    referenceNo: boundedText(issue.referenceNo, "", 120),
    rowNumber
  };
}

export function summarizeCentralBankResponseRows({
  databaseRows,
  issues,
  replayedFile,
  replayedRowNumbers
}: SummaryInput): CentralBankResponseGroups {
  const categorized = new Map<number, { category: CentralBankResponseCategory; detail: CentralBankResponseDetail }>();
  const replayedRowsForFile = replayedRows(replayedRowNumbers);

  if (Array.isArray(databaseRows)) {
    for (const raw of databaseRows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const rowNumber = safeRowNumber(row.row_number ?? row.rowNumber);
      if (!rowNumber || categorized.has(rowNumber)) continue;
      const outcome = String(row.outcome ?? "").trim().toLowerCase();
      const replayed = replayedFile || replayedRowsForFile.has(rowNumber);
      const category = categoryForOutcome(outcome, replayed);
      categorized.set(rowNumber, {
        category,
        detail: {
          ledger: boundedText(row.ledger, "", 60),
          message: boundedText(
            row.message,
            replayed || outcome === "replayed"
              ? "This payment result was already finalized."
              : category === "exceptions"
                ? "The finalizer returned an unsupported or invalid row result."
              : "This bank response row was processed."
          ),
          outcome: outcomeLabel(outcome, replayed),
          referenceNo: boundedText(row.reference_no ?? row.referenceNo, "", 120),
          rowNumber
        }
      });
    }
  }

  for (const issue of issues) {
    if (categorized.has(issue.rowNumber)) continue;
    const detail = issueDetail(issue);
    if (!detail) continue;
    categorized.set(detail.rowNumber, { category: issue.category, detail });
  }

  const groups: CentralBankResponseGroups = { reconciled: [], exceptions: [], skipped: [] };
  for (const { category, detail } of [...categorized.values()].sort(
    (left, right) => left.detail.rowNumber - right.detail.rowNumber
  )) {
    groups[category].push(detail);
  }
  return groups;
}

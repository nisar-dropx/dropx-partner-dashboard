export const WORKFORCE_PAYOUT_MANUAL_INPUT_TYPES = [
  "ATTENDANCE",
  "PRODUCTION_UNITS",
  "PAYMENT_FIELD_VALUE",
  "ADDITIONAL_PAYMENT",
  "DEDUCTION"
] as const;

export type WorkforcePayoutManualInputType = typeof WORKFORCE_PAYOUT_MANUAL_INPUT_TYPES[number];
export type WorkforcePayoutManualAction = "UPSERT" | "CLEAR";

export type WorkforcePayoutManualSelection = {
  id: string;
  dropxId: string;
  name: string;
  location: string;
  locationId?: string | null;
  status?: string;
};

export type WorkforcePayoutManualLine = {
  id: string;
  selectionKey: string;
  dropxId: string;
  name: string;
  location: string;
  action: WorkforcePayoutManualAction;
  inputType: WorkforcePayoutManualInputType | "";
  fieldCode: string;
  effectiveDate: string;
  effectiveTo: string;
  value: string;
  remark: string;
};

export type WorkforcePayoutManualLineIssue = {
  lineId: string;
  message: string;
};

export type WorkforcePayoutManualCatalogField = {
  code: string;
  label: string;
  inputType: WorkforcePayoutManualInputType;
  calculation: string;
  valueMeaning: string;
};

export type WorkforcePayoutManualCatalog = {
  fields: WorkforcePayoutManualCatalogField[];
  locations: Array<{ id: string; code: string; label: string }>;
};

export function workforcePayoutManualSelectionKey(selection: Pick<WorkforcePayoutManualSelection, "id" | "dropxId" | "location">) {
  return selection.id || `${selection.dropxId}|${selection.location}`;
}

export function createWorkforcePayoutManualLine(
  selection: WorkforcePayoutManualSelection,
  periodStart: string,
  periodEnd: string,
  id: string
): WorkforcePayoutManualLine {
  return {
    id,
    selectionKey: workforcePayoutManualSelectionKey(selection),
    dropxId: selection.dropxId,
    name: selection.name,
    location: selection.location === "-" ? "" : selection.location,
    action: "UPSERT",
    inputType: "",
    fieldCode: "",
    effectiveDate: periodStart,
    effectiveTo: periodEnd,
    value: "",
    remark: ""
  };
}

export function createWorkforcePayoutManualLines(
  selections: WorkforcePayoutManualSelection[],
  periodStart: string,
  periodEnd: string
) {
  return selections.map((selection, index) => createWorkforcePayoutManualLine(
    selection,
    periodStart,
    periodEnd,
    `manual-line-${index + 1}`
  ));
}

export function chunkWorkforcePayoutManualLines(
  lines: readonly WorkforcePayoutManualLine[],
  maximumLines: number
) {
  if (!Number.isSafeInteger(maximumLines) || maximumLines < 1) {
    throw new Error("The manual payout batch size must be a positive whole number.");
  }

  const groups = new Map<string, WorkforcePayoutManualLine[]>();
  lines.forEach((line, index) => {
    const selectionKey = line.selectionKey.trim() || `unscoped:${index}`;
    groups.set(selectionKey, [...(groups.get(selectionKey) ?? []), line]);
  });

  const chunks: WorkforcePayoutManualLine[][] = [];
  let current: WorkforcePayoutManualLine[] = [];
  for (const group of groups.values()) {
    if (group.length > maximumLines) {
      throw new Error(`One payout profile has more than ${maximumLines} manual input lines and cannot be applied safely.`);
    }
    if (current.length && current.length + group.length > maximumLines) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function normalizeWorkforcePayoutManualLineType(
  line: WorkforcePayoutManualLine,
  inputType: WorkforcePayoutManualInputType | "",
  periodStart: string,
  periodEnd: string
): WorkforcePayoutManualLine {
  const periodOnly = inputType === "ADDITIONAL_PAYMENT" || inputType === "DEDUCTION";
  const effectiveDate = periodOnly ? periodStart : line.effectiveDate || periodStart;
  return {
    ...line,
    inputType,
    fieldCode: "",
    effectiveDate,
    effectiveTo: periodOnly
      ? periodEnd
      : inputType === "PRODUCTION_UNITS"
        ? effectiveDate
        : line.effectiveTo || periodEnd
  };
}

function sameManualInput(left: WorkforcePayoutManualLine, right: WorkforcePayoutManualLine) {
  return left.inputType === right.inputType
    && left.fieldCode === right.fieldCode
    && left.effectiveDate === right.effectiveDate
    && left.effectiveTo === right.effectiveTo;
}

export function applyWorkforcePayoutManualLineToAll(
  lines: WorkforcePayoutManualLine[],
  sourceLineId: string,
  selections: WorkforcePayoutManualSelection[]
) {
  const source = lines.find((line) => line.id === sourceLineId);
  if (!source) return lines;
  const next = [...lines];
  const usedIds = new Set(next.map((line) => line.id));
  selections.forEach((selection, index) => {
    const selectionKey = workforcePayoutManualSelectionKey(selection);
    if (selectionKey === source.selectionKey) return;
    const matchingIndex = next.findIndex((line) => line.selectionKey === selectionKey && sameManualInput(line, source));
    const emptyIndex = matchingIndex >= 0
      ? -1
      : next.findIndex((line) => line.selectionKey === selectionKey && !line.inputType && !line.fieldCode && !line.value && !line.remark);
    const targetIndex = matchingIndex >= 0 ? matchingIndex : emptyIndex;
    let copyId = targetIndex >= 0 ? next[targetIndex].id : `${source.id}-copy-${index + 1}`;
    let copySuffix = index + 1;
    while (targetIndex < 0 && usedIds.has(copyId)) {
      copySuffix += 1;
      copyId = `${source.id}-copy-${copySuffix}`;
    }
    usedIds.add(copyId);
    const copy: WorkforcePayoutManualLine = {
      ...source,
      id: copyId,
      selectionKey,
      dropxId: selection.dropxId,
      name: selection.name,
      location: selection.location === "-" ? "" : selection.location
    };
    if (targetIndex >= 0) next[targetIndex] = copy;
    else next.push(copy);
  });
  return next;
}

function dateIsInside(value: string, periodStart: string, periodEnd: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= periodStart && value <= periodEnd;
}

export function validateWorkforcePayoutManualLines(
  lines: WorkforcePayoutManualLine[],
  periodStart: string,
  periodEnd: string
) {
  const issues: WorkforcePayoutManualLineIssue[] = [];
  const identities = new Map<string, string>();
  for (const line of lines) {
    if (!line.dropxId) issues.push({ lineId: line.id, message: "Select a Workforce payout." });
    if (!line.inputType) issues.push({ lineId: line.id, message: "Select an input type." });
    if (!line.fieldCode) issues.push({ lineId: line.id, message: "Select a field." });
    if (!dateIsInside(line.effectiveDate, periodStart, periodEnd)) {
      issues.push({ lineId: line.id, message: `From date must be inside ${periodStart} to ${periodEnd}.` });
    }
    if (!dateIsInside(line.effectiveTo, periodStart, periodEnd)) {
      issues.push({ lineId: line.id, message: `To date must be inside ${periodStart} to ${periodEnd}.` });
    } else if (line.effectiveTo < line.effectiveDate) {
      issues.push({ lineId: line.id, message: "To date cannot be before From date." });
    }
    if (line.inputType === "PRODUCTION_UNITS" && line.effectiveTo !== line.effectiveDate) {
      issues.push({ lineId: line.id, message: "Production units must use one work date." });
    }
    if ((line.inputType === "ADDITIONAL_PAYMENT" || line.inputType === "DEDUCTION")
      && (line.effectiveDate !== periodStart || line.effectiveTo !== periodEnd)) {
      issues.push({ lineId: line.id, message: "Additions and deductions must use the complete payout period." });
    }
    if (line.action === "UPSERT") {
      const numericValue = Number(line.value);
      if (!line.value.trim() || !Number.isFinite(numericValue)) {
        issues.push({ lineId: line.id, message: "Enter a valid numeric value." });
      } else if (numericValue < 0) {
        issues.push({ lineId: line.id, message: "Value cannot be negative." });
      }
    }
    const identity = [line.dropxId, line.location, line.inputType, line.fieldCode, line.effectiveDate, line.effectiveTo].join("|");
    const duplicate = identities.get(identity);
    if (line.inputType && duplicate) {
      issues.push({ lineId: line.id, message: "This line duplicates another selected payout input." });
    } else if (line.inputType) {
      identities.set(identity, line.id);
    }
  }
  return issues;
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildWorkforcePayoutManualCsv(lines: WorkforcePayoutManualLine[]) {
  const rows: unknown[][] = [
    ["ACTION", "DROPX_ID", "LOCATION", "INPUT_TYPE", "FIELD_CODE", "EFFECTIVE_DATE", "EFFECTIVE_TO", "VALUE", "REMARK"],
    ...lines.map((line) => [
      line.action,
      line.dropxId,
      line.location,
      line.inputType,
      line.fieldCode,
      // ISO values are intentionally used for the generated CSV. SheetJS reads
      // them as unambiguous spreadsheet date cells before the shared importer
      // applies its DD/MM/YYYY-or-Excel-date validation.
      line.effectiveDate,
      line.effectiveTo,
      line.action === "CLEAR" ? "" : line.value.trim(),
      line.remark.trim()
    ])
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

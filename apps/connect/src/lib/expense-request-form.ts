export const EXPENSE_PURPOSE_OPTIONS = [
  { code: "station_visit", label: "Station Visit" },
  { code: "client_visit_meeting", label: "Client Visit/Meeting" },
  { code: "recruitment_hiring_visit", label: "Recruitment/Hiring Visit" },
  { code: "audit_visit", label: "Audit Visit" },
  { code: "training_team_meeting", label: "Training/Team Meeting" },
  { code: "business_travel", label: "Business Travel" },
  { code: "local_travel", label: "Local Travel" },
  { code: "other", label: "Other" }
] as const;

export type ExpensePurposeCode = (typeof EXPENSE_PURPOSE_OPTIONS)[number]["code"];

export const EXPECTED_EXPENSE_KEYS = [
  { key: "travel", label: "Travel" },
  { key: "stay", label: "Stay" },
  { key: "local_conveyance", label: "Local Conveyance" },
  { key: "food_da", label: "Food/DA" },
  { key: "other", label: "Other" }
] as const;

export type ExpectedExpenseKey = (typeof EXPECTED_EXPENSE_KEYS)[number]["key"];
export type ExpectedExpenses = Record<ExpectedExpenseKey, number>;

export function emptyExpectedExpenses(): ExpectedExpenses {
  return {
    travel: 0,
    stay: 0,
    local_conveyance: 0,
    food_da: 0,
    other: 0
  };
}

export function purposeLabel(code: string | null | undefined, fallback = "") {
  const match = EXPENSE_PURPOSE_OPTIONS.find((option) => option.code === code);
  return match?.label ?? fallback;
}

export function sumExpectedExpenses(value: Partial<Record<string, number>> | null | undefined) {
  return EXPECTED_EXPENSE_KEYS.reduce((sum, entry) => sum + (Number(value?.[entry.key]) || 0), 0);
}

export function normalizeExpectedExpenses(value: unknown): ExpectedExpenses {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next = emptyExpectedExpenses();
  for (const entry of EXPECTED_EXPENSE_KEYS) {
    const amount = Number(source[entry.key] ?? 0);
    next[entry.key] = Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
  }
  return next;
}

export function isExpensePurposeCode(value: string): value is ExpensePurposeCode {
  return EXPENSE_PURPOSE_OPTIONS.some((option) => option.code === value);
}

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

export type ExpectedExpenseKey = string;
export type ExpectedExpenses = Record<string, number>;

export function emptyExpectedExpenses(): ExpectedExpenses {
  return {};
}

export type RequestExpenseCategory = { id: string; show_in_expense_requests: boolean };

export function requestExpenseCategories<T extends RequestExpenseCategory>(categories: T[]): T[] {
  return categories.filter(category => category.show_in_expense_requests === true);
}

export function requestExpenseAmounts(value: ExpectedExpenses, categories: RequestExpenseCategory[]): ExpectedExpenses {
  return Object.fromEntries(requestExpenseCategories(categories)
    .filter(category => Number(value[category.id]) > 0)
    .map(category => [category.id, value[category.id]]));
}

export function validateRequestExpenseAmounts(value: ExpectedExpenses, categories: RequestExpenseCategory[]) {
  const allowed = new Set(requestExpenseCategories(categories).map(category => category.id));
  if (Object.entries(value).some(([key, amount]) => amount > 0 && !allowed.has(key))) {
    throw new Error("Expense categories have changed. Refresh the form and review your estimates.");
  }
}

export function purposeLabel(code: string | null | undefined, fallback = "") {
  const match = EXPENSE_PURPOSE_OPTIONS.find((option) => option.code === code);
  return match?.label ?? fallback;
}

export function sumExpectedExpenses(value: Partial<Record<string, number>> | null | undefined) {
  return Object.values(value ?? {}).reduce<number>((sum, amount) => sum + (Number(amount) || 0), 0);
}

export function normalizeExpectedExpenses(value: unknown): ExpectedExpenses {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next: ExpectedExpenses = {};
  for (const [key, value] of Object.entries(source).slice(0, 100)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) continue;
    const amount = Number(value);
    next[key] = Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
  }
  return next;
}

export function isExpensePurposeCode(value: string): value is ExpensePurposeCode {
  return EXPENSE_PURPOSE_OPTIONS.some((option) => option.code === value);
}

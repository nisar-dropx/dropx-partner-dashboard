export type AutomaticDeductionHead = {
  code: string;
  name?: string | null;
  calculation_type: "fixed" | "percentage" | "manual";
  default_value: number;
  percentage_without_pan: number;
  workforce_category_codes: string[];
  applies_to_all: boolean;
  is_system: boolean;
  is_active: boolean;
};

export type DeductionWorkerContext = {
  categoryCode?: string | null;
  panNumber?: string | null;
};

export type AutomaticDeductionLine = { code: string; label: string; amount: number };

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function hasValidPanNumber(value: unknown) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(value ?? "").trim().toUpperCase());
}

export function calculateAutomaticDeductionLines(grossEarnings: number, heads: AutomaticDeductionHead[], worker: DeductionWorkerContext = {}): AutomaticDeductionLine[] {
  const gross = Math.max(0, Number(grossEarnings) || 0);
  return heads.flatMap((head) => {
    if (!head.is_active || !head.applies_to_all || head.calculation_type === "manual") return [];
    const categoryCodes = Array.isArray(head.workforce_category_codes) ? head.workforce_category_codes : [];
    const isSystemTds = head.is_system && String(head.code).toUpperCase() === "TDS";
    if (isSystemTds && !categoryCodes.length) return [];
    if (categoryCodes.length && (!worker.categoryCode || !categoryCodes.includes(worker.categoryCode))) return [];
    const configuredValue = isSystemTds && !hasValidPanNumber(worker.panNumber)
      ? head.percentage_without_pan
      : head.default_value;
    const value = Math.max(0, Number(configuredValue) || 0);
    return [{ code: head.code, label: String(head.name ?? head.code), amount: roundCurrency(head.calculation_type === "percentage" ? gross * value / 100 : value) }];
  });
}

export function calculateAutomaticDeductions(grossEarnings: number, heads: AutomaticDeductionHead[], worker: DeductionWorkerContext = {}) {
  return roundCurrency(calculateAutomaticDeductionLines(grossEarnings, heads, worker).reduce((sum, line) => sum + line.amount, 0));
}

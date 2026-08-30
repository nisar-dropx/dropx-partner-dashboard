export type AutomaticDeductionHead = {
  code: string;
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

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function hasValidPanNumber(value: unknown) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(value ?? "").trim().toUpperCase());
}

export function calculateAutomaticDeductions(grossEarnings: number, heads: AutomaticDeductionHead[], worker: DeductionWorkerContext = {}) {
  const gross = Math.max(0, Number(grossEarnings) || 0);
  const total = heads.reduce((sum, head) => {
    if (!head.is_active || !head.applies_to_all || head.calculation_type === "manual") return sum;
    const categoryCodes = Array.isArray(head.workforce_category_codes) ? head.workforce_category_codes : [];
    const isSystemTds = head.is_system && String(head.code).toUpperCase() === "TDS";
    if (isSystemTds && !categoryCodes.length) return sum;
    if (categoryCodes.length && (!worker.categoryCode || !categoryCodes.includes(worker.categoryCode))) return sum;
    const configuredValue = isSystemTds && !hasValidPanNumber(worker.panNumber)
      ? head.percentage_without_pan
      : head.default_value;
    const value = Math.max(0, Number(configuredValue) || 0);
    return sum + (head.calculation_type === "percentage" ? gross * value / 100 : value);
  }, 0);
  return roundCurrency(total);
}

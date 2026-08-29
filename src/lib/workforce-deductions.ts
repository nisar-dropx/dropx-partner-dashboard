export type AutomaticDeductionHead = {
  calculation_type: "fixed" | "percentage" | "manual";
  default_value: number;
  applies_to_all: boolean;
  is_active: boolean;
};

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateAutomaticDeductions(grossEarnings: number, heads: AutomaticDeductionHead[]) {
  const gross = Math.max(0, Number(grossEarnings) || 0);
  const total = heads.reduce((sum, head) => {
    if (!head.is_active || !head.applies_to_all || head.calculation_type === "manual") return sum;
    const value = Math.max(0, Number(head.default_value) || 0);
    return sum + (head.calculation_type === "percentage" ? gross * value / 100 : value);
  }, 0);
  return roundCurrency(total);
}

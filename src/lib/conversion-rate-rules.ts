export type ConversionRateTier = { minimum: number; rate: number };
export type ConversionRateRule = {
  id: string;
  company_id: string;
  payment_method_id: string;
  payment_field_id: string;
  provider_id: string;
  location_model_id: string;
  station_id: string;
  numerator_source: string;
  denominator_source: string;
  effective_from: string;
  effective_to: string;
  tiers: unknown;
};

export function conversionRateTiers(value: unknown): ConversionRateTier[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("Enter between 1 and 20 conversion slabs.");
  const tiers = value.map((tier) => {
    if (!tier || typeof tier !== "object" || typeof tier.minimum !== "number" || typeof tier.rate !== "number"
      || !Number.isFinite(tier.minimum) || !Number.isFinite(tier.rate)
      || tier.minimum < 0 || tier.minimum > 100 || tier.rate < 0) {
      throw new Error("Slab minimums must be between 0 and 100 and rates must be non-negative numbers.");
    }
    return { minimum: tier.minimum, rate: tier.rate };
  }).sort((a, b) => a.minimum - b.minimum);
  if (tiers[0].minimum !== 0 || tiers.some((tier, index) => index > 0 && tier.minimum === tiers[index - 1].minimum)) {
    throw new Error("Start slabs at 0% and use a different minimum for each slab.");
  }
  return tiers;
}

/** Per provider ID, work date and location. Never rounds conversion before selecting a slab. */
export function resolveConversionRate(input: {
  rules: readonly ConversionRateRule[];
  companyId: string;
  paymentMethodId: string;
  paymentFieldId: string;
  providerId: string;
  modelId: string;
  stationId: string;
  date: string;
  rows: readonly Record<string, unknown>[];
  fallbackRate: number;
}) {
  const matches = input.rules.filter(rule => rule.company_id === input.companyId
    && rule.payment_method_id === input.paymentMethodId && rule.payment_field_id === input.paymentFieldId
    && rule.provider_id === input.providerId && rule.location_model_id === input.modelId
    && rule.station_id === input.stationId && rule.effective_from <= input.date && rule.effective_to >= input.date);
  const fallback = { rate: input.fallbackRate, ruleId: null as string | null, conversion: null as number | null };
  if (!matches.length) return fallback;
  if (matches.length !== 1) throw new Error("Overlapping conversion rate rules. Resolve the rate configuration before calculating payments.");
  const rule = matches[0];
  if (!input.rows.length) return fallback;
  let completedTotal = 0, baseTotal = 0;
  for (const row of input.rows) {
    const numeratorValue = row[rule.numerator_source], denominatorValue = row[rule.denominator_source];
    if (numeratorValue == null || denominatorValue == null || numeratorValue === "" || denominatorValue === "") return fallback;
    const numerator = Number(numeratorValue), denominator = Number(denominatorValue);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator < 0 || denominator < 0 || numerator > denominator) return fallback;
    completedTotal += numerator;
    baseTotal += denominator;
  }
  if (baseTotal <= 0 || !Number.isFinite(completedTotal) || !Number.isFinite(baseTotal)) return fallback;
  const conversion = completedTotal / baseTotal * 100;
  // Cross multiplication avoids a boundary such as 58 / 200 * 100 becoming 28.999999999999996.
  const tier = conversionRateTiers(rule.tiers).filter(tier => completedTotal * 100 >= tier.minimum * baseTotal).at(-1)!;
  return { rate: tier.rate, ruleId: matches[0].id, conversion };
}

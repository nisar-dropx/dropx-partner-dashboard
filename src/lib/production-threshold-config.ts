export type ProductionThresholdPeriod = "day" | "month";

export type ProductionThresholdConfig = {
  period: ProductionThresholdPeriod;
  component_codes: string[];
};

type PaymentComponent = {
  component_code: unknown;
  component_type: unknown;
};

function normalizeComponentCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizedProductionCodes(components: readonly PaymentComponent[]) {
  const seen = new Set<string>();
  const codes: string[] = [];

  for (const component of components) {
    if (component.component_type !== "production") continue;
    const code = normalizeComponentCode(component.component_code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  return codes;
}

export function parseProductionThresholdConfig(value: unknown): ProductionThresholdConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { period?: unknown; component_codes?: unknown };
  if (candidate.period !== "day" && candidate.period !== "month") return null;
  if (!Array.isArray(candidate.component_codes)) return null;
  if (candidate.component_codes.some((code) => typeof code !== "string" || !normalizeComponentCode(code))) return null;

  const componentCodes = [...new Set(candidate.component_codes.map(normalizeComponentCode).filter(Boolean))];
  if (!componentCodes.length) return null;

  return { period: candidate.period, component_codes: componentCodes };
}

export function buildProductionThresholdConfig(input: {
  enabled: boolean;
  period: unknown;
  selectedComponentCodes: readonly unknown[];
  components: readonly PaymentComponent[];
}): ProductionThresholdConfig | null {
  if (!input.enabled) return null;
  if (input.period !== "day" && input.period !== "month") {
    throw new Error("Choose whether the combined production minimum resets every day or every month.");
  }

  const productionCodes = normalizedProductionCodes(input.components);
  const requestedCodes = new Set(input.selectedComponentCodes.map(normalizeComponentCode).filter(Boolean));
  const componentCodes = productionCodes.filter((code) => requestedCodes.has(code));

  if (!componentCodes.length) {
    throw new Error("Select at least one production field for the combined production minimum.");
  }
  if ([...requestedCodes].some((code) => !productionCodes.includes(code))) {
    throw new Error("The combined production minimum can include only production fields selected in this payment method.");
  }

  return { period: input.period, component_codes: componentCodes };
}

export function productionThresholdLabel(config: ProductionThresholdConfig | null) {
  if (!config) return null;
  return `Combined minimum per ${config.period}`;
}

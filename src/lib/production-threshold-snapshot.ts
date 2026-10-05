import {
  parseProductionThresholdConfig,
  type ProductionThresholdConfig
} from "./production-threshold-config.ts";

export type ProductionThresholdSnapshot = ProductionThresholdConfig & {
  minimum_units: number;
};

export type DisabledProductionThresholdSnapshot = {
  enabled: false;
};

export type MappingProductionThresholdSnapshot =
  | ProductionThresholdSnapshot
  | DisabledProductionThresholdSnapshot;

export function disabledProductionThresholdSnapshot(): DisabledProductionThresholdSnapshot {
  return { enabled: false };
}

export function isProductionThresholdExplicitlyDisabled(
  value: unknown
): value is DisabledProductionThresholdSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 1 && entries[0][0] === "enabled" && entries[0][1] === false;
}

export function parseProductionThresholdSnapshot(value: unknown): ProductionThresholdSnapshot | null {
  const config = parseProductionThresholdConfig(value);
  if (!config || !value || typeof value !== "object" || Array.isArray(value)) return null;

  const minimumUnits = Number((value as { minimum_units?: unknown }).minimum_units);
  if (!Number.isInteger(minimumUnits) || minimumUnits <= 0) return null;

  return { ...config, minimum_units: minimumUnits };
}

export function buildProductionThresholdSnapshot(
  config: ProductionThresholdConfig | null,
  minimumUnits: unknown
): ProductionThresholdSnapshot | null {
  if (!config) return null;

  const rawValue = String(minimumUnits ?? "").trim();
  const parsedValue = Number(rawValue);
  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Combined minimum per ${config.period} must be a positive whole number.`);
  }

  return { ...config, minimum_units: parsedValue };
}

function sameProductionThresholdSnapshot(
  left: ProductionThresholdSnapshot,
  right: ProductionThresholdSnapshot
) {
  return left.period === right.period
    && left.minimum_units === right.minimum_units
    && left.component_codes.length === right.component_codes.length
    && left.component_codes.every((code, index) => code === right.component_codes[index]);
}

/**
 * Resolves the immutable threshold snapshot written to an effective-dated
 * provider mapping. Existing versions never inherit a later method rule: a
 * threshold change must create a new mapping period with a later start date.
 */
export function resolveMappingProductionThresholdSnapshot(input: {
  existingValue: unknown;
  editsExistingVersion: boolean;
  paymentMethodChanged?: boolean;
  methodConfig: ProductionThresholdConfig | null;
  minimumUnits: unknown;
  inheritedMinimumUnits?: unknown;
}): MappingProductionThresholdSnapshot {
  const existing = parseProductionThresholdSnapshot(input.existingValue);
  const rawMinimum = String(input.minimumUnits ?? "").trim();

  if (input.editsExistingVersion) {
    if (input.paymentMethodChanged && (existing || input.methodConfig)) {
      throw new Error("To change a threshold payment method, choose a later Effective From date so earlier payouts stay unchanged.");
    }
    if (!existing) {
      if (rawMinimum) {
        throw new Error("To enable a combined production minimum, choose a later Effective From date so earlier payouts stay unchanged.");
      }
      // Null is a legacy pre-feature value. Normalize it to an explicit
      // disabled sentinel instead of inheriting the mutable live method rule.
      return disabledProductionThresholdSnapshot();
    }

    const candidate = buildProductionThresholdSnapshot(
      { period: existing.period, component_codes: existing.component_codes },
      rawMinimum || existing.minimum_units
    );
    if (!candidate || !sameProductionThresholdSnapshot(existing, candidate)) {
      throw new Error("To change a combined production minimum, choose a later Effective From date so earlier payouts stay unchanged.");
    }
    return existing;
  }

  if (!input.methodConfig) return disabledProductionThresholdSnapshot();
  return buildProductionThresholdSnapshot(
    input.methodConfig,
    rawMinimum || input.inheritedMinimumUnits
  )!;
}

export function productionThresholdMinimumLabel(config: ProductionThresholdConfig) {
  return `Combined minimum / ${config.period}`;
}

export function monthlyThresholdChangeRequiresMonthStart(
  previous: ProductionThresholdSnapshot | null,
  next: ProductionThresholdSnapshot | null
) {
  if (previous?.period !== "month" || !next) return false;
  const previousCodes = previous.component_codes.join("|");
  const nextCodes = next.component_codes.join("|");
  return next.period !== previous.period
    || next.minimum_units !== previous.minimum_units
    || nextCodes !== previousCodes;
}

export function isFirstDayOfMonth(value: string) {
  return /^\d{4}-\d{2}-01$/.test(value);
}

import {
  parseProductionThresholdConfig,
} from "./production-threshold-config.ts";
import {
  isProductionThresholdExplicitlyDisabled,
  parseProductionThresholdSnapshot,
  type ProductionThresholdSnapshot
} from "./production-threshold-snapshot.ts";

export type EffectiveProductionThresholdConfig = ProductionThresholdSnapshot;

export type WorkforceProductionThresholdInput = {
  id: string;
  workforceId: string;
  mappingId: string;
  date: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  componentCode: string;
  componentOrder?: number | null;
  reportedUnits: number;
  rate: number;
  thresholdConfig?: unknown;
  methodThresholdConfig?: unknown;
};

export type WorkforceProductionThresholdAllocation = WorkforceProductionThresholdInput & {
  reportedUnits: number;
  thresholdApplied: boolean;
  thresholdDeducted: number;
  payableUnits: number;
  amount: number;
  thresholdPeriod: "day" | "month" | null;
  thresholdMinimum: number | null;
  thresholdConfigurationMissing: boolean;
};

const normalizedCode = (value: unknown) => String(value ?? "").trim().toUpperCase();
const roundedAmount = (value: number) => Math.round(value * 100) / 100;

export function parseEffectiveProductionThresholdConfig(value: unknown): EffectiveProductionThresholdConfig | null {
  return parseProductionThresholdSnapshot(value);
}

function thresholdConfigKey(config: EffectiveProductionThresholdConfig) {
  return JSON.stringify({
    period: config.period,
    // The stored component order is part of the effective-dated rule because
    // it decides which rate receives the first payable units at the crossing.
    component_codes: config.component_codes,
    minimum_units: config.minimum_units
  });
}

function activeOn(input: WorkforceProductionThresholdInput) {
  return /^\d{4}-\d{2}-\d{2}$/.test(input.date)
    && input.effectiveFrom <= input.date
    && (!input.effectiveTo || input.effectiveTo >= input.date);
}

/**
 * Applies a combined production minimum across every active provider mapping
 * for the same canonical workforce person. Processing order is chronological,
 * then payment-field order within a day, so the component that crosses the
 * minimum receives only its excess units at its own rate.
 */
export function allocateCombinedProductionThresholds(
  inputs: readonly WorkforceProductionThresholdInput[]
): WorkforceProductionThresholdAllocation[] {
  const prepared = inputs
    .map((input, index) => {
      const config = parseEffectiveProductionThresholdConfig(input.thresholdConfig);
      const thresholdExplicitlyDisabled = isProductionThresholdExplicitlyDisabled(input.thresholdConfig);
      const methodConfig = parseProductionThresholdConfig(input.methodThresholdConfig);
      const code = normalizedCode(input.componentCode);
      const configuredIndex = (config ?? methodConfig)?.component_codes.indexOf(code) ?? -1;
      const explicitOrder = Number(input.componentOrder);
      return {
        input,
        index,
        code,
        config,
        thresholdExplicitlyDisabled,
        methodConfig,
        // A mapping snapshot freezes the payment-field order for historical
        // payouts. Only fall back to the live component order for fields that
        // are outside the combined rule.
        order: configuredIndex >= 0
          ? configuredIndex
          : Number.isFinite(explicitOrder)
            ? explicitOrder
            : Number.MAX_SAFE_INTEGER
      };
    })
    .filter(({ input }) => activeOn(input))
    .sort((left, right) => left.input.workforceId.localeCompare(right.input.workforceId)
      || left.input.date.localeCompare(right.input.date)
      || left.order - right.order
      || left.code.localeCompare(right.code)
      || left.input.mappingId.localeCompare(right.input.mappingId)
      || left.input.id.localeCompare(right.input.id)
      || left.index - right.index);

  const consumedByBucket = new Map<string, number>();

  return prepared.map(({ input, code, config, thresholdExplicitlyDisabled, methodConfig }) => {
    const reportedUnits = Number.isFinite(Number(input.reportedUnits))
      ? Math.max(0, Number(input.reportedUnits))
      : 0;
    const rate = Number.isFinite(Number(input.rate)) ? Number(input.rate) : 0;
    const thresholdConfigurationMissing = Boolean(
      !config
      && !thresholdExplicitlyDisabled
      && methodConfig?.component_codes.includes(code)
    );
    const thresholdApplied = Boolean(config?.component_codes.includes(code) || thresholdConfigurationMissing);
    let thresholdDeducted = 0;

    if (thresholdConfigurationMissing) {
      // The method says this component is thresholded, but its effective
      // mapping has no numeric snapshot. Fail closed rather than paying units
      // whose person-specific minimum is unknown.
      thresholdDeducted = reportedUnits;
    } else if (config && thresholdApplied) {
      const periodBucket = config.period === "month" ? input.date.slice(0, 7) : input.date;
      const bucketKey = `${input.workforceId}|${thresholdConfigKey(config)}|${periodBucket}`;
      const consumed = consumedByBucket.get(bucketKey) ?? 0;
      const remaining = Math.max(0, config.minimum_units - consumed);
      thresholdDeducted = Math.min(reportedUnits, remaining);
      consumedByBucket.set(bucketKey, consumed + reportedUnits);
    }

    const payableUnits = Math.max(0, reportedUnits - thresholdDeducted);
    return {
      ...input,
      componentCode: code,
      reportedUnits,
      rate,
      thresholdApplied,
      thresholdDeducted,
      payableUnits,
      amount: roundedAmount(payableUnits * rate),
      thresholdPeriod: thresholdApplied ? (config ?? methodConfig)?.period ?? null : null,
      thresholdMinimum: thresholdApplied && config ? config.minimum_units : null,
      thresholdConfigurationMissing
    };
  });
}

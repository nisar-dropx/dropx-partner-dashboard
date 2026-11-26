/**
 * Configurable order-spike / demand signal evaluation (pure).
 * Rules live in ds_ops_signal_rules — never hardcode thresholds in UI/cron.
 */

export type DsSignalMetric = "active_orders" | "orders_per_hour" | "pending_acceptance";

export type DsOpsSignalRule = {
  metric: DsSignalMetric;
  baselineDays: number;
  thresholdPct: number;
  minSamples: number;
  enabled: boolean;
  stationCode: string | null;
};

export type DsSignalObservation = {
  /** Same hour-of-day samples across prior days, or recent active_orders samples. */
  samples: number[];
  current: number;
};

export type DsSignalResult = {
  metric: DsSignalMetric;
  spiked: boolean;
  baseline: number | null;
  current: number;
  liftPct: number | null;
  reason: string;
};

export function resolveSignalRule(
  rules: DsOpsSignalRule[],
  metric: DsSignalMetric,
  stationCode: string
): DsOpsSignalRule | null {
  const enabled = (rules ?? []).filter((r) => r.enabled && r.metric === metric);
  const station = enabled.find((r) => (r.stationCode ?? "").toUpperCase() === stationCode.toUpperCase());
  if (station) return station;
  return enabled.find((r) => r.stationCode == null || r.stationCode === "") ?? null;
}

export function evaluateSignal(rule: DsOpsSignalRule | null, observation: DsSignalObservation): DsSignalResult {
  const metric = rule?.metric ?? "active_orders";
  const current = Number(observation.current);
  if (!rule || !rule.enabled) {
    return { metric, spiked: false, baseline: null, current, liftPct: null, reason: "No enabled rule" };
  }
  const samples = (observation.samples ?? []).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (samples.length < rule.minSamples) {
    return {
      metric,
      spiked: false,
      baseline: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
      current,
      liftPct: null,
      reason: `Need ${rule.minSamples} baseline samples (have ${samples.length})`
    };
  }
  const baseline = samples.reduce((a, b) => a + b, 0) / samples.length;
  if (!(baseline > 0)) {
    const spiked = current > 0;
    return {
      metric,
      spiked,
      baseline,
      current,
      liftPct: null,
      reason: spiked ? "Baseline was zero with current demand" : "No baseline demand"
    };
  }
  const liftPct = ((current - baseline) / baseline) * 100;
  const spiked = liftPct >= rule.thresholdPct;
  return {
    metric,
    spiked,
    baseline: Math.round(baseline * 100) / 100,
    current,
    liftPct: Math.round(liftPct * 10) / 10,
    reason: spiked
      ? `${liftPct.toFixed(0)}% above ${rule.baselineDays}d baseline (≥ ${rule.thresholdPct}%)`
      : `${liftPct.toFixed(0)}% vs baseline (threshold ${rule.thresholdPct}%)`
  };
}

export function defaultSignalRules(): DsOpsSignalRule[] {
  return [
    { metric: "active_orders", baselineDays: 7, thresholdPct: 40, minSamples: 3, enabled: true, stationCode: null },
    { metric: "orders_per_hour", baselineDays: 7, thresholdPct: 40, minSamples: 3, enabled: true, stationCode: null },
    { metric: "pending_acceptance", baselineDays: 7, thresholdPct: 50, minSamples: 3, enabled: true, stationCode: null }
  ];
}

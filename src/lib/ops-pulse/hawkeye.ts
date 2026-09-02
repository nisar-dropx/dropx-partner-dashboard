export type HawkeyeMetricDefinition = {
  label: string;
  short: string;
  targetKey?: string;
};

export const hawkeyeMetricDefinitions: HawkeyeMetricDefinition[] = [
  { label: "AFN Prem DEA%", short: "AFN Prem DEA" },
  { label: "AFN Prem DOT%", short: "AFN Prem DOT", targetKey: "afn_premium_dot" },
  { label: "AFN Prem LM Miss%", short: "AFN Prem LM Miss", targetKey: "afn_premium_lmc_dea" },
  { label: "AFN Prem PDD DSR%", short: "AFN Prem DSR" },
  { label: "AFN Std DEA%", short: "AFN Std DEA" },
  { label: "AFN Std DOT%", short: "AFN Std DOT", targetKey: "afn_standard_dot" },
  { label: "AFN Std LM Miss%", short: "AFN Std LM Miss", targetKey: "afn_standard_lmc_dea" },
  { label: "AFN Std PDD DSR%", short: "AFN Std DSR" },
  { label: "Prem DDS%", short: "Premium DDS", targetKey: "dds_premium" },
  { label: "Prem FDDS%", short: "Premium FDDS" },
  { label: "Prem FTDS%", short: "Premium FTDS" },
  { label: "Premium RDDS%", short: "Premium RDDS" },
  { label: "Std DDS%", short: "Standard DDS", targetKey: "dds_standard" },
  { label: "Std FDDS%", short: "Standard FDDS" },
  { label: "Std FTDS%", short: "Standard FTDS" },
  { label: "Standard RDDS%", short: "Standard RDDS" },
  { label: "Easyship DEA%", short: "Easyship DEA" },
  { label: "Easyship DOT%", short: "Easyship DOT" },
  { label: "Easyship DDS%", short: "Easyship DDS" },
  { label: "Easyship FDDS%", short: "Easyship FDDS" },
  { label: "Easyship RDDS%", short: "Easyship RDDS" },
  { label: "Non Del GS%", short: "Non-delivery GS", targetKey: "non_delivered_good_scan" },
  { label: "Pickup Failed GS%", short: "Pickup failed GS", targetKey: "unsuccessful_pickup_good_scan" },
  { label: "Invalid Scans%", short: "Invalid scans" },
  { label: "HFR Adh Neutralized%", short: "HFR neutralized" },
  { label: "CReturn FDPS%", short: "C-return FDPS", targetKey: "c_ret_fdps" },
  { label: "CReturn PSR%", short: "C-return PSR" },
  { label: "Post Attempt CPS%", short: "Post-attempt CPS", targetKey: "forward_cps" },
  { label: "MFN - EF FDPS%", short: "MFN EF FDPS" },
  { label: "MFN - ES FDPS%", short: "MFN ES FDPS" },
  { label: "SMD2 Slot AD%", short: "SMD2 slot", targetKey: "slot_adherence" },
  { label: "Store Returns%", short: "Store returns" }
];

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function hawkeyeMetrics(valuesJson: unknown) {
  if (!valuesJson || typeof valuesJson !== "object" || Array.isArray(valuesJson)) return null;
  const metrics = (valuesJson as { metrics?: unknown }).metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const result = new Map<string, number | null>();
  Object.entries(metrics as Record<string, unknown>).forEach(([label, value]) => {
    const number = value == null || value === "" ? null : Number(value);
    result.set(normalized(label), number != null && Number.isFinite(number) ? number : null);
  });
  return result;
}

export function hawkeyeValue(valuesJson: unknown, label: string) {
  return hawkeyeMetrics(valuesJson)?.get(normalized(label)) ?? null;
}

const targetMetricLabels: Record<string, string> = {
  afn_premium_lmc_dea: "AFN Prem LM Miss%",
  afn_standard_lmc_dea: "AFN Std LM Miss%",
  afn_premium_dot: "AFN Prem DOT%",
  afn_standard_dot: "AFN Std DOT%",
  dds_premium: "Prem DDS%",
  dds_standard: "Std DDS%",
  non_delivered_good_scan: "Non Del GS%",
  unsuccessful_pickup_good_scan: "Pickup Failed GS%",
  slot_adherence: "SMD2 Slot AD%",
  forward_cps: "Post Attempt CPS%",
  dsr: "AFN Std PDD DSR%"
};

export function hawkeyeValueForTarget(valuesJson: unknown, metricKey: string) {
  const label = targetMetricLabels[metricKey];
  return label ? hawkeyeValue(valuesJson, label) : null;
}

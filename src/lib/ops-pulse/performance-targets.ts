import { supabaseAdmin } from "@/lib/supabase-admin";
import { hawkeyeMetricDefinitions, hawkeyeTargetKey } from "./hawkeye";

export type PerformanceTarget = {
  id?: string;
  metricKey: string;
  label: string;
  short: string;
  reportType: "daily" | "sls";
  sourceIndex: number | null;
  target: number | null;
  direction: "higher" | "lower";
  weight: number;
  unit: "percent" | "dpmo" | "ratio";
  displayOrder: number;
  isActive: boolean;
  mappingVersion?: number;
  explicitReviewTarget?: boolean;
};

const daily = [
  ["afn_premium_lmc_dea", "AFN Premium LMC DEA", "AFN Prem LMC DEA", 1, "lower"],
  ["afn_standard_lmc_dea", "AFN Standard LMC DEA", "AFN Std LMC DEA", 2, "lower"],
  ["mfn_premium_lmc_dea", "MFN Premium LMC DEA", "MFN Prem LMC DEA", 3, "lower"],
  ["mfn_standard_lmc_dea", "MFN Standard LMC DEA", "MFN Std LMC DEA", 4, "lower"],
  ["afn_premium_dot", "AFN Premium DOT", "AFN Prem DOT", 5, "higher"],
  ["afn_standard_dot", "AFN Standard DOT", "AFN Std DOT", 6, "higher"],
  ["mfn_premium_dot", "MFN Premium DOT", "MFN Prem DOT", 7, "higher"],
  ["mfn_standard_dot", "MFN Standard DOT", "MFN Std DOT", 8, "higher"],
  ["dot_premium", "DOT – Premium", "DOT Premium", 9, "higher"],
  ["dot_standard", "DOT – Standard", "DOT Standard", 10, "higher"],
  ["dds_premium", "DDS – Premium", "Premium DDS", 11, "higher"],
  ["dds_standard", "DDS – Standard", "Standard DDS", 12, "higher"],
  ["non_delivered_good_scan", "Non-Delivered Good Scan", "Good Scan Non-Del", 13, "higher"],
  ["unsuccessful_pickup_good_scan", "Unsuccessful Pickup Good Scan", "Good Scan Not Picked", 14, "higher"],
  ["slot_adherence", "SMD 2.0 Slot Adherence", "Slot Adherence", 15, "higher"],
  ["forward_cps", "Forward-Leg Contacts / Shipment", "LM CPS", 16, "lower"],
  ["reverse_cps", "Reverse-Leg Contacts / Shipment", "LM RCPS", 17, "lower"],
  ["open_cod", "Open COD (>7 Days)", "Open COD >7D", 18, "lower"],
  ["dnr_48h", "DNR Within 48 Hours", "DNR <48H", 19, "lower"],
  ["dsr", "Delivery Success Rate", "DSR", 20, "higher"]
] as const;

const sls = [
  ["gst_pendency", "%GST Pendency", 22, "lower", 2.5, "percent"],
  ["helmet_adherence", "Helmet Adherence", 2, "higher", 10, "percent"],
  ["dot_standard", "DOT – Standard", 3, "higher", 5, "percent"],
  ["dot_premium", "DOT – Premium", 4, "higher", 5, "percent"],
  ["dds_standard", "DDS – Standard", 5, "higher", 5, "percent"],
  ["dds_premium", "DDS – Premium", 6, "higher", 5, "percent"],
  ["c_ret_fdps", "C-Ret FDPS", 7, "higher", 5, "percent"],
  ["in_facility_losses", "In-Facility Losses vs Goal", 8, "lower", 5, "ratio"],
  ["short_cash", "Short Cash", 9, "lower", 5, "percent"],
  ["open_cod", "Open COD (>7 Days)", 10, "lower", 5, "percent"],
  ["non_delivered_good_scan", "Non-Delivered Good Scan", 15, "higher", 5, "percent"],
  ["unsuccessful_pickup_good_scan", "Unsuccessful Pickup Good Scan", 16, "higher", 5, "percent"],
  ["rts_dpmo", "RTS DPMO", 11, "lower", 5, "dpmo"],
  ["undel_dpmo", "Undel DPMO vs Goal", 14, "lower", 5, "ratio"],
  ["swa_cod_dsr", "SWA COD DSR", 12, "higher", 10, "percent"],
  ["swa_prepaid_dsr", "SWA Prepaid DSR", 13, "higher", 2.5, "percent"],
  ["forward_cps", "Forward-Leg Contacts / Shipment", 17, "lower", 5, "percent"],
  ["reverse_cps", "Reverse-Leg Contacts / Shipment", 18, "lower", 2.5, "percent"],
  ["dnr_dpmo", "DNR DPMO Within 48 Hours", 19, "lower", 2.5, "dpmo"],
  ["dnr_rescue", "DNR Rescue Rate", 20, "higher", 2.5, "percent"],
  ["readme_otr", "ReadMe OTR", 21, "higher", 2.5, "percent"]
] as const;

// Catalog metadata only. Numeric thresholds come exclusively from the editable master.
export const performanceTargetSeeds: PerformanceTarget[] = [
  ...daily.map((row, index) => ({ metricKey: row[0], label: row[1], short: row[2], reportType: "daily" as const, sourceIndex: row[3], target: null, direction: row[4], weight: 0, unit: "percent" as const, displayOrder: index + 1, isActive: true })),
  ...sls.map((row, index) => ({ metricKey: row[0], label: row[1], short: row[1], reportType: "sls" as const, sourceIndex: row[2], target: null, direction: row[3], weight: row[4], unit: row[5], displayOrder: index + 1, isActive: true, mappingVersion: 2 }))
] as PerformanceTarget[];

function sourceCode(target: PerformanceTarget) { return `perf_target_${target.reportType}_${target.metricKey}`; }
function payload(target: PerformanceTarget) { return JSON.stringify(target); }
function parse(row: { id: string; description: string | null }) {
  try { return { ...(JSON.parse(row.description ?? "{}") as PerformanceTarget), id: row.id }; } catch { return null; }
}

const reviewCatalog = hawkeyeMetricDefinitions.map((definition, index): PerformanceTarget => ({
  metricKey: hawkeyeTargetKey(definition), label: definition.label, short: definition.short,
  reportType: "daily", sourceIndex: null, target: null, direction: "higher",
  weight: 0, unit: "percent", displayOrder: 100 + index, isActive: true
}));

export async function loadPerformanceTargets(companyId: string, options: { readOnly?: boolean } = {}) {
  if (!supabaseAdmin) return { rows: [] as PerformanceTarget[], error: "Database service is unavailable." };
  const admin = supabaseAdmin;
  let result = await admin.from("report_import_master").select("id,description").eq("company_id", companyId).eq("parser_type", "performance_target").order("source_code");
  if (!result.error && !(result.data ?? []).length) {
    if (options.readOnly) return { rows: performanceTargetSeeds, error: null };
    const seeded = await supabaseAdmin.from("report_import_master").upsert(performanceTargetSeeds.map((target) => ({
      company_id: companyId, source_code: sourceCode(target), name: target.label, description: payload(target),
      file_types: [], day_offset: 0, frequency: target.reportType === "daily" ? "daily" : "weekly",
      parser_type: "performance_target", dedupe_fields: [target.reportType, target.metricKey], is_active: true
    })), { onConflict: "company_id,source_code" });
    if (seeded.error) return { rows: [] as PerformanceTarget[], error: seeded.error.message };
    result = await supabaseAdmin.from("report_import_master").select("id,description").eq("company_id", companyId).eq("parser_type", "performance_target").order("source_code");
  }
  const rows = (result.data ?? []).map(parse).filter(Boolean) as PerformanceTarget[];
  // Every review metric has an editable master row. Never supply an assumed
  // threshold and never overwrite an existing value, inactive row or override.
  const missing = reviewCatalog.filter(metric => !rows.some(row => row.reportType === "daily" && row.metricKey === metric.metricKey));
  if (!result.error && !options.readOnly && missing.length) {
    const inserted = await admin.from("report_import_master").upsert(missing.map(target => ({
      company_id: companyId, source_code: sourceCode(target), name: target.label, description: payload(target),
      file_types: [], day_offset: 0, frequency: "daily", parser_type: "performance_target",
      dedupe_fields: [target.reportType, target.metricKey], is_active: true
    })), { onConflict: "company_id,source_code", ignoreDuplicates: true }).select("id,description");
    if (inserted.error) return { rows, error: inserted.error.message };
    rows.push(...(inserted.data ?? []).map(parse).filter(Boolean) as PerformanceTarget[]);
  }
  const legacySlsRows = rows.filter((row) => row.reportType === "sls" && row.mappingVersion !== 2);
  if (!result.error && legacySlsRows.length) {
    await Promise.all(legacySlsRows.map(async (row) => {
      const canonical = performanceTargetSeeds.find((seed) => seed.reportType === "sls" && seed.metricKey === row.metricKey);
      if (!canonical || !row.id) return;
      const corrected = { ...row, sourceIndex: canonical.sourceIndex, mappingVersion: 2 };
      row.sourceIndex = corrected.sourceIndex;
      row.mappingVersion = 2;
      if (!options.readOnly) await admin.from("report_import_master").update({ description: payload(corrected), updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", row.id);
    }));
  }
  return { rows, error: result.error?.message ?? null };
}

export async function savePerformanceTarget(companyId: string, id: string, target: PerformanceTarget) {
  if (!supabaseAdmin) return "Database service is unavailable.";
  const result = await supabaseAdmin.from("report_import_master").update({
    name: target.label, description: payload(target), frequency: target.reportType === "daily" ? "daily" : "weekly", is_active: target.isActive, updated_at: new Date().toISOString()
  }).eq("company_id", companyId).eq("id", id).eq("parser_type", "performance_target");
  return result.error?.message ?? null;
}

export async function createPerformanceTarget(companyId: string, target: PerformanceTarget) {
  if (!supabaseAdmin) return "Database service is unavailable.";
  const result = await supabaseAdmin.from("report_import_master").insert({
    company_id: companyId,
    source_code: sourceCode(target),
    name: target.label,
    description: payload(target),
    file_types: [],
    day_offset: 0,
    frequency: target.reportType === "daily" ? "daily" : "weekly",
    parser_type: "performance_target",
    dedupe_fields: [target.reportType, target.metricKey],
    is_active: true
  });
  return result.error?.message ?? null;
}

export async function deletePerformanceTarget(companyId: string, id: string) {
  if (!supabaseAdmin) return "Database service is unavailable.";
  const result = await supabaseAdmin
    .from("report_import_master")
    .delete()
    .eq("company_id", companyId)
    .eq("id", id)
    .eq("parser_type", "performance_target");
  return result.error?.message ?? null;
}

export function resolvePerformanceTargets(rows: PerformanceTarget[], reportType: "daily" | "sls") {
  const active = rows.filter((row) => row.isActive);
  const resolved = active.filter((row) => row.reportType === reportType).map((row) => {
    if (row.target != null || row.explicitReviewTarget) return row;
    const equivalent = active.find((candidate) => candidate.reportType !== reportType && candidate.metricKey === row.metricKey && candidate.target != null);
    return equivalent && equivalent.unit === row.unit ? { ...row, target: equivalent.target, direction: equivalent.direction } : row;
  });
  // Hawkeye contains metrics (notably C-return FDPS) whose target exists only
  // in SLS. Resolve the exact canonical metric key even without a daily row.
  // Never copy an SLS column index into the older daily import layout, and
  // never revive a deliberately disabled/explicitly untargeted daily metric.
  if (reportType === "daily") {
    for (const definition of hawkeyeMetricDefinitions) {
      const key = hawkeyeTargetKey(definition);
      if (rows.some(row => row.reportType === "daily" && row.metricKey === key)) continue;
      const equivalent = active.find(row => row.reportType === "sls" && row.metricKey === key && row.unit === "percent" && row.target != null);
      if (equivalent) resolved.push({ ...equivalent, id: undefined, reportType: "daily", sourceIndex: null,
        label: definition.label, short: definition.short, weight: 0, displayOrder: 100 + hawkeyeMetricDefinitions.indexOf(definition) });
    }
  }
  return resolved.sort((a, b) => a.displayOrder - b.displayOrder);
}

import { supabaseAdmin } from "@/lib/supabase-admin";

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
  ["afn_premium_lmc_dea", "AFN Premium LMC DEA", "AFN Prem LMC DEA", 1, .0064, "lower"],
  ["afn_standard_lmc_dea", "AFN Standard LMC DEA", "AFN Std LMC DEA", 2, .0038, "lower"],
  ["mfn_premium_lmc_dea", "MFN Premium LMC DEA", "MFN Prem LMC DEA", 3, .0077, "lower"],
  ["mfn_standard_lmc_dea", "MFN Standard LMC DEA", "MFN Std LMC DEA", 4, .0053, "lower"],
  ["afn_premium_dot", "AFN Premium DOT", "AFN Prem DOT", 5, .955, "higher"],
  ["afn_standard_dot", "AFN Standard DOT", "AFN Std DOT", 6, .935, "higher"],
  ["mfn_premium_dot", "MFN Premium DOT", "MFN Prem DOT", 7, .955, "higher"],
  ["mfn_standard_dot", "MFN Standard DOT", "MFN Std DOT", 8, .935, "higher"],
  ["dot_premium", "DOT – Premium", "DOT Premium", 9, .955, "higher"],
  ["dot_standard", "DOT – Standard", "DOT Standard", 10, .935, "higher"],
  ["dds_premium", "DDS – Premium", "Premium DDS", 11, .94, "higher"],
  ["dds_standard", "DDS – Standard", "Standard DDS", 12, .89, "higher"],
  ["non_delivered_good_scan", "Non-Delivered Good Scan", "Good Scan Non-Del", 13, .9, "higher"],
  ["unsuccessful_pickup_good_scan", "Unsuccessful Pickup Good Scan", "Good Scan Not Picked", 14, .83, "higher"],
  ["slot_adherence", "SMD 2.0 Slot Adherence", "Slot Adherence", 15, .987, "higher"],
  ["forward_cps", "Forward-Leg Contacts / Shipment", "LM CPS", 16, .003, "lower"],
  ["reverse_cps", "Reverse-Leg Contacts / Shipment", "LM RCPS", 17, .0105, "lower"],
  ["open_cod", "Open COD (>7 Days)", "Open COD >7D", 18, .001, "lower"],
  ["dnr_48h", "DNR Within 48 Hours", "DNR <48H", 19, null, "lower"],
  ["dsr", "Delivery Success Rate", "DSR", 20, null, "higher"]
] as const;

const sls = [
  ["gst_pendency", "%GST Pendency", 22, .001, "lower", 2.5, "percent"],
  ["helmet_adherence", "Helmet Adherence", 2, .985, "higher", 10, "percent"],
  ["dot_standard", "DOT – Standard", 3, .935, "higher", 5, "percent"],
  ["dot_premium", "DOT – Premium", 4, .955, "higher", 5, "percent"],
  ["dds_standard", "DDS – Standard", 5, .89, "higher", 5, "percent"],
  ["dds_premium", "DDS – Premium", 6, .94, "higher", 5, "percent"],
  ["c_ret_fdps", "C-Ret FDPS", 7, .955, "higher", 5, "percent"],
  ["in_facility_losses", "In-Facility Losses vs Goal", 8, 1, "lower", 5, "ratio"],
  ["short_cash", "Short Cash", 9, .001, "lower", 5, "percent"],
  ["open_cod", "Open COD (>7 Days)", 10, .001, "lower", 5, "percent"],
  ["non_delivered_good_scan", "Non-Delivered Good Scan", 15, .9, "higher", 5, "percent"],
  ["unsuccessful_pickup_good_scan", "Unsuccessful Pickup Good Scan", 16, .83, "higher", 5, "percent"],
  ["rts_dpmo", "RTS DPMO", 11, 500, "lower", 5, "dpmo"],
  ["undel_dpmo", "Undel DPMO vs Goal", 14, 1, "lower", 5, "ratio"],
  ["swa_cod_dsr", "SWA COD DSR", 12, .684, "higher", 10, "percent"],
  ["swa_prepaid_dsr", "SWA Prepaid DSR", 13, .98, "higher", 2.5, "percent"],
  ["forward_cps", "Forward-Leg Contacts / Shipment", 17, .003, "lower", 5, "percent"],
  ["reverse_cps", "Reverse-Leg Contacts / Shipment", 18, .0105, "lower", 2.5, "percent"],
  ["dnr_dpmo", "DNR DPMO Within 48 Hours", 19, 900, "lower", 2.5, "dpmo"],
  ["dnr_rescue", "DNR Rescue Rate", 20, .85, "higher", 2.5, "percent"],
  ["readme_otr", "ReadMe OTR", 21, .95, "higher", 2.5, "percent"]
] as const;

export const performanceTargetSeeds: PerformanceTarget[] = [
  ...daily.map((row, index) => ({ metricKey: row[0], label: row[1], short: row[2], reportType: "daily" as const, sourceIndex: row[3], target: row[4], direction: row[5], weight: 0, unit: "percent" as const, displayOrder: index + 1, isActive: true })),
  ...sls.map((row, index) => ({ metricKey: row[0], label: row[1], short: row[1], reportType: "sls" as const, sourceIndex: row[2], target: row[3], direction: row[4], weight: row[5], unit: row[6], displayOrder: index + 1, isActive: true, mappingVersion: 2 }))
] as PerformanceTarget[];

function sourceCode(target: PerformanceTarget) { return `perf_target_${target.reportType}_${target.metricKey}`; }
function payload(target: PerformanceTarget) { return JSON.stringify(target); }
function parse(row: { id: string; description: string | null }) {
  try { return { ...(JSON.parse(row.description ?? "{}") as PerformanceTarget), id: row.id }; } catch { return null; }
}

export async function loadPerformanceTargets(companyId: string) {
  if (!supabaseAdmin) return { rows: [] as PerformanceTarget[], error: "Database service is unavailable." };
  const admin = supabaseAdmin;
  let result = await admin.from("report_import_master").select("id,description").eq("company_id", companyId).eq("parser_type", "performance_target").order("source_code");
  if (!result.error && !(result.data ?? []).length) {
    const seeded = await supabaseAdmin.from("report_import_master").upsert(performanceTargetSeeds.map((target) => ({
      company_id: companyId, source_code: sourceCode(target), name: target.label, description: payload(target),
      file_types: [], day_offset: 0, frequency: target.reportType === "daily" ? "daily" : "weekly",
      parser_type: "performance_target", dedupe_fields: [target.reportType, target.metricKey], is_active: true
    })), { onConflict: "company_id,source_code" });
    if (seeded.error) return { rows: [] as PerformanceTarget[], error: seeded.error.message };
    result = await supabaseAdmin.from("report_import_master").select("id,description").eq("company_id", companyId).eq("parser_type", "performance_target").order("source_code");
  }
  const rows = (result.data ?? []).map(parse).filter(Boolean) as PerformanceTarget[];
  const legacySlsRows = rows.filter((row) => row.reportType === "sls" && row.mappingVersion !== 2);
  if (!result.error && legacySlsRows.length) {
    await Promise.all(legacySlsRows.map(async (row) => {
      const canonical = performanceTargetSeeds.find((seed) => seed.reportType === "sls" && seed.metricKey === row.metricKey);
      if (!canonical || !row.id) return;
      const corrected = { ...row, sourceIndex: canonical.sourceIndex, mappingVersion: 2 };
      row.sourceIndex = corrected.sourceIndex;
      row.mappingVersion = 2;
      await admin.from("report_import_master").update({ description: payload(corrected), updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", row.id);
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
  return active.filter((row) => row.reportType === reportType).map((row) => {
    if (row.target != null || row.explicitReviewTarget) return row;
    const equivalent = active.find((candidate) => candidate.reportType !== reportType && candidate.metricKey === row.metricKey && candidate.target != null);
    return equivalent ? { ...row, target: equivalent.target, direction: equivalent.direction, unit: equivalent.unit } : row;
  }).sort((a, b) => a.displayOrder - b.displayOrder);
}

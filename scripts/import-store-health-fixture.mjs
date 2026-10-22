/**
 * Parses the Store Health fixture PDF and prints the store rows that Report Upload
 * would persist. With STORE_HEALTH_IMPORT=1 and service credentials, also inserts
 * report_metric_facts via the same shape as /api/report-imports.
 *
 * Usage:
 *   node --experimental-strip-types scripts/import-store-health-fixture.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  parseStoreHealthScorecardPdf,
  storeHealthValuesJson,
  STORE_HEALTH_DAILY_SOURCE
} from "../src/lib/ops-pulse/store-health-scorecard.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "scripts/fixtures/qc-store-health-scorecard-20Oct2026.pdf");
const bytes = readFileSync(fixture);
const parsed = await parseStoreHealthScorecardPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

assert.equal(parsed.performanceDate, "2026-10-20");
assert.equal(parsed.stores.length, 5);

const summary = parsed.stores.map((store) => ({
  station: store.stationCode,
  city: store.city,
  score: store.scorePct,
  band: store.band,
  points: `${store.pointsEarned}/${store.pointsAvailable}`,
  metrics: Object.keys(store.metrics).length
}));
console.log(JSON.stringify({ performanceDate: parsed.performanceDate, stores: summary }, null, 2));

if (process.env.STORE_HEALTH_IMPORT !== "1") {
  console.log("Dry run only. Set STORE_HEALTH_IMPORT=1 with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to write facts.");
  process.exit(0);
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
const company = await db.from("companies").select("id").limit(1).maybeSingle();
if (company.error || !company.data) throw new Error(company.error?.message ?? "No company");
const companyId = company.data.id;

const stations = await db.from("stations").select("station_code").eq("company_id", companyId).eq("is_active", true);
const allowed = new Set((stations.data ?? []).map((row) => String(row.station_code).toUpperCase().replace(/[^A-Z0-9]/g, "")));
const matched = parsed.stores.filter((store) => allowed.has(store.stationCode));
if (!matched.length) throw new Error("No fixture stores match active stations in this project.");

const batch = await db.from("report_import_batches").insert({
  company_id: companyId,
  source_type: STORE_HEALTH_DAILY_SOURCE,
  file_name: "qc-store-health-scorecard-20Oct2026.pdf",
  status: "Completed",
  report_from: parsed.performanceDate,
  report_to: parsed.performanceDate,
  imported_row_count: matched.length,
  row_count: parsed.stores.length,
  message: `Fixture import · ${matched.length} stores for ${parsed.performanceDate}`,
  station_code: matched.map((store) => store.stationCode).sort().join(", "),
  completed_at: new Date().toISOString()
}).select("id").single();
if (batch.error) throw new Error(batch.error.message);

const year = Number(parsed.performanceDate.slice(0, 4));
const facts = matched.map((store) => {
  const values = storeHealthValuesJson(store, parsed.performanceDate);
  const row_hash = createHash("sha256").update(JSON.stringify({
    sourceType: STORE_HEALTH_DAILY_SOURCE,
    reportDate: parsed.performanceDate,
    stationCode: store.stationCode,
    values,
    parserVersion: 1
  })).digest("hex");
  return {
    batch_id: batch.data.id,
    company_id: companyId,
    page_number: store.pageNumber,
    raw_text: store.rawText,
    report_date: parsed.performanceDate,
    report_week: null,
    report_year: year,
    row_hash,
    row_label: store.city,
    row_number: 1,
    source_type: STORE_HEALTH_DAILY_SOURCE,
    station_code: store.stationCode,
    values_json: values
  };
});

const inserted = await db.from("report_metric_facts").upsert(facts, { onConflict: "company_id,source_type,row_hash", ignoreDuplicates: true }).select("station_code");
if (inserted.error) throw new Error(inserted.error.message);
console.log(`Imported ${inserted.data?.length ?? 0} Store Health fact row(s) into batch ${batch.data.id}.`);

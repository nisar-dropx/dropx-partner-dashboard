import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));

// Execute the real loader and identity resolver with a read-only database double.
// This catches the Workforce branch omission as well as the physical-site query scope.
function loadWithDatabase(file, db, cache = new Map()) {
  const filename = path.resolve(file);
  if (cache.has(filename)) return cache.get(filename);
  const exported = {};
  cache.set(filename, exported);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(source, {
    exports: exported,
    require: (specifier) => {
      if (specifier.endsWith("supabase-admin")) return { supabaseAdmin: db };
      if (specifier.startsWith("@/")) return loadWithDatabase(path.join(root, specifier.slice(2)) + ".ts", db, cache);
      if (specifier.startsWith(".")) return loadWithDatabase(path.resolve(path.dirname(filename), specifier) + ".ts", db, cache);
      return nativeRequire(specifier);
    },
    Map, Set, Date, Intl, console
  }, { filename });
  return exported;
}

function database(tables, calls) {
  return { from(table) {
    const call = { table, filters: [], ors: [] };
    calls.push(call);
    const query = {
      select(columns) { call.columns = columns; return this; },
      eq(key, value) { call.filters.push([key, value]); return this; },
      in() { return this; },
      not() { return this; },
      ilike(key, value) { call.ilike = [key, value]; return this; },
      lte() { return this; },
      or(value) { call.ors.push(value); return this; },
      order() { return this; },
      range(start, end) { call.range = [start, end]; return this; },
      maybeSingle() { call.single = true; return this; },
      then(resolve, reject) {
        let data = (tables[table] ?? []).filter((row) => call.filters.every(([key, value]) => row[key] === value));
        if (call.ilike) data = data.filter((row) => /^in/i.test(row[call.ilike[0]]));
        if (call.range) data = data.slice(call.range[0], call.range[1] + 1);
        return Promise.resolve({ data: call.single ? data[0] ?? null : data, error: null }).then(resolve, reject);
      }
    };
    return query;
  } };
}

test("real loader resolves Workforce name and isolates physical JUGF from assigned JUGD", async () => {
  const company_id = "company";
  const punch = { company_id, punch_date: "2026-09-03", calculated: true, punch_label: "In1",
    enrolment_id: "140071", profile_type: "workforce", account_id: "person-f", employee_id: null,
    field_executive_id: null, device_id: "device-f", device_serial: "serial-f", source: "biometric",
    geofence_status: null, location_id: "JUGD", punch_time: "2026-09-03T01:17:23Z" };
  const calls = [];
  const db = database({
    biometric_devices: [
      { company_id, id: "device-f", device_serial: "serial-f", location_id: "JUGF" },
      { company_id, id: "device-d", device_serial: "serial-d", location_id: "JUGD" }
    ],
    attendance_punches: [punch,
      { ...punch, device_id: "device-d", device_serial: "serial-d", enrolment_id: "714",
        profile_type: "contractor", account_id: "person-d", punch_time: "2026-09-03T04:08:09Z" },
      { ...punch, calculated: false, punch_time: "2026-09-03T00:30:00Z" },
      { ...punch, punch_label: "Out1", punch_time: "2026-09-03T00:40:00Z" }
    ],
    attendance_daily: [{ company_id, punch_date: "2026-09-03", enrolment_id: "140071",
      in_time: punch.punch_time, punch_in_location_id: "JUGF", punch_in_station_code: "JUGF",
      worker_name: null, employee_code: null, work_mode: "onsite" }],
    biometric_enrolments: [
      { company_id, enrolment_id: "140071", profile_type: "workforce", account_id: "person-f" },
      { company_id, enrolment_id: "714", profile_type: "contractor", account_id: "person-d" }
    ],
    workforce: [{ company_id, id: "person-f", full_name: "KHUSIRAJ SANANI", dropx_id: "SDGH140071", location_id: "JUGD" }],
    contractors: [{ company_id, id: "person-d", full_name: "ROHAN KUMAR PATRA", dropx_id: "D0714", location_id: "JUGD" }],
    stations: [{ company_id, id: "JUGD", station_code: "JUGD" }]
  }, calls);
  const { loadStationOpeningAttendance } = loadWithDatabase(fileURLToPath(new URL("./station-opening-attendance.ts", import.meta.url)), db);
  const result = await loadStationOpeningAttendance(company_id, "2026-09-03",
    ["JUGD", "JUGF"].map((id) => ({ id, station_code: id })),
    new Map(["JUGD", "JUGF"].map((id) => [id, { start: "02:00:00", end: "10:00:00" }])));
  assert.equal(result.get("JUGF").name, "KHUSIRAJ SANANI");
  assert.equal(result.get("JUGF").time, "2026-09-03T01:17:23Z");
  assert.equal(result.get("JUGD").name, "ROHAN KUMAR PATRA");
  assert.equal(result.get("JUGD").time, "2026-09-03T04:08:09Z");
  const eventQuery = calls.find((call) => call.table === "attendance_punches");
  assert.match(eventQuery.ors[0], /device_id.in/);
  assert.match(eventQuery.ors[0], /source.eq.app_gps,geofence_status.eq.inside/);
  const dailyQuery = calls.find((call) => call.table === "attendance_daily");
  assert.match(dailyQuery.ors[0], /^punch_in_location_id.in/);
  assert.ok(calls.every((call) => call.filters.some(([key, value]) => key === "company_id" && value === company_id)));
});

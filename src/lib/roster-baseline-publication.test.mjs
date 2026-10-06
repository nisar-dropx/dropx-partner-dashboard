import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const peoplePath = new URL("../app/(hrms)/rostering/actions.ts", import.meta.url);
const isPeople = existsSync(peoplePath);
const path = isPeople ? peoplePath : new URL("../app/ops-pulse/rostering/actions.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const start = source.indexOf("async function syncRecurringBaselineFromDatedPlan");
const end = source.indexOf("\nasync function ", start + 1);
const body = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const entries = (worker, days = 7) => Array.from({ length: days }, (_, i) => ({
  company_id: "company", plan_id: "source", worker_type: "contractor", worker_id: worker,
  roster_date: "2026-10-" + String(5 + i).padStart(2, "0"), day_type: i === 6 ? "weekly_off" : "working",
  shift_id: i === 6 ? null : "shift", notes: null
}));
function harness({ days = 7, copiedError = false } = {}) {
  const plans = [{ id: "old", company_id: "company", location_id: "station", roster_kind: "recurring_weekly",
    status: "approved", effective_from: "2026-10-05", revision_no: 15, superseded_at: null }];
  const tables = { hr_roster_plans: plans, hr_roster_entries: entries("person", days),
    hr_roster_plan_locations: [], stations: [{ id: "station", company_id: "company", station_code: "TEST" }] };
  const writes = [], retired = [];
  let serial = 0;
  const admin = { from(table) {
    const filters = []; let change, insertion, order, limit;
    const q = {
      select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
      gte(k, v) { filters.push(r => r[k] >= v); return q; }, lte(k, v) { filters.push(r => r[k] <= v); return q; },
      order(k, options) { order = [k, options]; return q; }, limit(n) { limit = n; return q; },
      insert(rows) { insertion = Array.isArray(rows) ? rows : [rows]; return q; },
      update(values) { change = values; return q; },
      single() { return Promise.resolve(run(true)); }, maybeSingle() { return Promise.resolve(run(true)); },
      then(resolve, reject) { return Promise.resolve(run(false)).then(resolve, reject); }
    };
    function run(single) {
      if (copiedError && table === "hr_roster_entries" && insertion) return { data: null, error: { message: "Copy failed" } };
      let rows = tables[table].filter(r => filters.every(f => f(r)));
      if (order) rows.sort((a, b) => (a[order[0]] - b[order[0]]) * (order[1].ascending ? 1 : -1));
      if (limit) rows = rows.slice(0, limit);
      if (insertion) { rows = insertion.map(r => ({ id: "new-" + (++serial), ...r })); tables[table].push(...rows); writes.push({ table, insertion: structuredClone(rows) }); }
      if (change) { rows.forEach(r => Object.assign(r, change)); writes.push({ table, change: structuredClone(change) }); }
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
    return q;
  } };
  const sync = new Function("db", "lastFullWeekStart", "addDays", "addRosterDays", "authorisedStation",
    "retireFullyReplacedRosterPlans", body + "\nreturn syncRecurringBaselineFromDatedPlan;")(
    () => admin, () => "2026-10-05", () => "2026-10-11", () => "2026-10-11",
    async () => ({ station_code: "TEST" }), async (_, company, id) => retired.push(id));
  const plan = { id: "source", location_id: "station", period_start: "2026-10-05", period_end: "2026-10-11", roster_kind: "dated" };
  const run = () => isPeople ? sync({ companyId: "company", userId: "actor" }, plan) : sync("company", { userId: "actor" }, plan);
  return { run, plans, tables, writes, retired };
}
test("a newly approved same-week edit becomes the repeating baseline", async () => {
  const h = harness(); await h.run();
  const created = h.plans.find(p => p.id !== "old");
  assert.equal(created.revision_no, 16);
  assert.equal(created.supersedes_plan_id, "source");
  assert.equal(created.status, "approved");
  assert.equal(h.tables.hr_roster_entries.filter(e => e.plan_id === created.id).length, 7);
  assert.deepEqual(h.retired, [created.id]);
  assert(h.writes.findIndex(w => w.table === "hr_roster_entries") < h.writes.findIndex(w => w.change?.status === "approved"));
  await h.run(); assert.equal(h.plans.length, 2, "same source is idempotent");
});
test("an incomplete approved week cannot replace the existing pattern", async () => {
  const h = harness({ days: 3 }); await h.run();
  assert.equal(h.plans.length, 1); assert.deepEqual(h.retired, []);
});
test("failed entry copying never publishes or retires a baseline", async () => {
  const h = harness({ copiedError: true }); await assert.rejects(h.run(), /Copy failed/);
  assert.equal(h.plans[0].status, "approved"); assert.equal(h.plans[0].superseded_at, null);
  assert.equal(h.plans[1].status, "draft"); assert.deepEqual(h.retired, []);
});


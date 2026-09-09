import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function compile(path, dependencies = {}) {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(read(path), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
  } }).outputText)(name => dependencies[name] ?? require(name), exports);
  return exports;
}
const operations = compile("src/lib/ops-pulse/review-operations.ts");
const logic = compile("src/lib/ops-pulse/review-discipline-rca.ts", { "./review-operations": operations });
const opening = { firstPunchAt: "2026-09-08T06:12:00+05:30", firstPunchBy: "Arjun", scheduledOpeningTime: "06:00:00", openingLateMinutes: 12 };
const staff = { id: "employee:a", name: "Arjun", code: "D1", role: "Team Lead", shift: "06:00–15:00", inTime: opening.firstPunchAt, status: "12 min late", lateMinutes: 12 };
const utr = { rows: [staff, { ...staff, id: "contractor:a", name: "Arjun" }, { ...staff, id: "employee:b", status: "Roster off" }, { ...staff, id: "employee:c", status: "Shift not linked" }, { ...staff, id: "employee:d", status: "On time", lateMinutes: 0 }] };
const rows = logic.buildDisciplineRca(opening, utr);
assert.deepEqual(rows.map(r => r.key), ["station_opening_late", "utr_late_employee_a", "utr_late_contractor_a"], "distinct profiles with same name keep separate reasons; off/no shift excluded");
assert.ok(rows[0].evidence.includes("06:00") && rows[0].evidence.includes("12 min late"));
assert.ok(rows[1].evidence.includes("Team Lead") && rows[1].evidence.includes("D1"));
for (const values of [{ openingLateMinutes: 0 }, { openingLateMinutes: null }, { firstPunchAt: null }, { scheduledOpeningTime: null }]) {
  assert.equal(logic.buildDisciplineRca({ ...opening, ...values }, { rows: [] }).length, 0);
}
assert.equal(logic.disciplineReason("  Transport\n delay  "), "Transport delay");
assert.throws(() => logic.disciplineReason(" \n "), /short reason/);
assert.throws(() => logic.disciplineReason("x".repeat(241)), /240/);
assert.equal(logic.missingDisciplineReasons(rows, [{ metric_key: rows[0].key, root_cause: "Bus delay" }]).length, 2);
assert.equal(logic.missingDisciplineReasons(rows, rows.map(r => ({ metric_key: r.key, root_cause: "Bus delay" }))).length, 0);

// Server action tests run with an in-memory database; no real review inputs are created.
let calls = [], saved = [], sourceError = false, scope = true, allowRca = false, allowComplete = true;
const review = { id: "review1", station_id: "station1", station_code: "QLDA", source_date: "2026-09-08", current_step_order: 2, status: "in_review", updated_at: "version1" };
const step = { id: "step2", step_order: 2, status: "pending" };
const authorization = { userId: "reviewer", fullName: "Reviewer", hasAllLocationAccess: false, locationScopeIds: ["station1"] };
const db = { from(table) {
  const filters = [];
  const result = () => ({ data: table === "stations" ? (scope ? { id: "station1", station_code: "QLDA" } : null)
    : table === "ops_performance_reviews" ? review : table === "ops_performance_review_steps" ? [step] : saved, error: null });
  const q = { select() { return q; }, eq(k,v) { filters.push([k,v]); calls.push([table,k,v]); return q; }, maybeSingle() { return Promise.resolve(result()); }, order() { return Promise.resolve(result()); }, then(resolve,reject) { return Promise.resolve(result()).then(resolve,reject); } };
  return q;
}, async rpc(name, args) { calls.push([name,args]); if (args.p_action === "item") saved.push({ metric_key: args.p_data.metric_key, root_cause: args.p_data.root_cause }); return { error: null }; } };
const dependencies = {
  "next/cache": { revalidatePath() {} }, "@/lib/authorization": { requirePagePermission: async () => authorization },
  "@/lib/company-scope": { requireCompanyId: () => "company1" }, "@/lib/supabase-admin": { supabaseAdmin: db },
  "@/lib/ops-pulse/performance-review": {}, "@/lib/ops-pulse/review-policy": {},
  "@/lib/ops-pulse/review-access": { getReviewAccess: async () => ({ canEditRca: allowRca, canComplete: allowComplete, canComment: allowComplete, actor: { label: "AOM" } }) },
  "@/lib/ops-pulse/review-discipline-rca": logic,
  "@/lib/ops-pulse/review-discipline-rca-data": { loadDisciplineRca: async (company, station, date) => {
    assert.equal(company, "company1"); assert.equal(station.id, "station1"); assert.equal(date, "2026-09-08");
    if (sourceError) throw Error("Source unavailable"); return rows;
  } }
};
const actions = compile("src/app/ops-pulse/performance/actions.ts", dependencies);
const form = (overrides = {}) => { const f = new FormData(); for (const [key, value] of Object.entries({ review_id: "review1", station_code: "QLDA", source_date: "2026-09-08", metric_key: rows[0].key, root_cause: "Bus delay", metric_label: "Forged person", actual_value: "999", intent: "complete", step_id: "step2", ...overrides })) f.set(key, value); return f; };
assert.match((await actions.savePerformanceReviewComment(form())).error, /3 short delay reasons/);
assert.ok(!calls.some(c => c[0] === "ops_mutate_manager_review"), "missing reasons cannot complete the stage");
assert.match((await actions.savePerformanceDisciplineReason(form({ root_cause: " " }))).error, /short reason/);
assert.match((await actions.savePerformanceDisciplineReason(form({ root_cause: "x".repeat(241) }))).error, /240/);
assert.match((await actions.savePerformanceDisciplineReason(form({ metric_key: "utr_late_employee_outside" }))).error, /no longer present/);
allowComplete = false;
assert.match((await actions.savePerformanceDisciplineReason(form())).error, /current reviewer/);
allowComplete = true; scope = false;
assert.match((await actions.savePerformanceDisciplineReason(form())).error, /location access/);
scope = true; sourceError = true;
assert.match((await actions.savePerformanceReviewComment(form())).error, /Source unavailable/);
sourceError = false;
for (const row of rows) assert.equal((await actions.savePerformanceDisciplineReason(form({ metric_key: row.key }))).notice, "Delay reason saved.");
const written = calls.filter(c => c[0] === "ops_mutate_manager_review").map(c => c[1]);
assert.equal(written[0].p_data.metric_label, rows[0].label, "server—not client—sets person and delay evidence");
assert.equal(written[0].p_data.actual_value, 12);
assert.equal(written[0].p_data.corrective_action, "", "only the short reason is required");
assert.equal(written[0].p_data.expected_review_version, "version1");
assert.ok(calls.some(c => c[0] === "ops_performance_review_items" && c[1] === "company_id" && c[2] === "company1"));
assert.equal((await actions.savePerformanceReviewComment(form())).notice, "Your review is complete. The next manager can now review.");
assert.equal((await actions.savePerformanceReviewItem(form())).error, "RCA and actions are editable by the first review manager during their stage, or Program Manager.", "later manager does not gain metric RCA rights");
allowRca = true;
assert.match((await actions.savePerformanceReviewItem(form())).error, /delay reason form/);

const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
const ui = compile("src/components/performance-rca-actions.tsx", {
  "@/lib/date-format": { formatDashboardDate: v => v }, "@/app/ops-pulse/performance/actions": actions,
  "@/lib/ops-pulse/review-discipline-rca": logic,
  "@/components/review-attendance-history": { ReviewPersonHistoryLink: () => null },
  "@/components/review-action-form": { ReviewActionForm: ({ children, className }) => React.createElement("form", { className }, children) }
});
const props = { canEdit: false, canEditDiscipline: true, activeDisciplineKeys: rows.map(r => r.key), rows, date: review.source_date, itemsByMetric: new Map(), reviewId: review.id, reviewVersion: review.updated_at, stationCode: "QLDA" };
let html = renderToStaticMarkup(React.createElement(ui.PerformanceRcaActions, props));
assert.equal((html.match(/Reason for delay/g) ?? []).length, 3);
assert.equal((html.match(/maxLength="240"/g) ?? []).length, 3);
assert.ok(!html.includes("textarea") && !html.includes("1200.0%") && !html.includes("Next action"));
html = renderToStaticMarkup(React.createElement(ui.PerformanceRcaActions, { ...props, canEditDiscipline: false, itemsByMetric: new Map([[rows[0].key, { root_cause: "Transport delay" }]]) }));
assert.ok(html.includes("Transport delay") && html.includes("Reason saved") && !html.includes("<form"));
html = renderToStaticMarkup(React.createElement(ui.PerformanceRcaActions, { ...props, canEdit: true, reviewStarted: false, startControl: React.createElement("button",null,"Start review & add RCA") }));
assert.ok(html.includes("The review has not started") && html.includes("Start review &amp; add RCA") && html.includes("Opening &amp; UTR delays · reason only"));
assert.ok(!html.includes('name="root_cause"') && !html.includes("<form"), "unstarted review shows the misses and start action, never an unsaveable reason form");
const metric = {key:"afn_std_dot",label:"AFN Std DOT",actual:0.8,target:0.935,direction:"higher",severity:"red"};
html = renderToStaticMarkup(React.createElement(ui.PerformanceRcaActions, { ...props, canEdit:true, rows:[...rows,metric] }));
assert.ok(html.indexOf("Performance misses · RCA &amp; action plan") < html.indexOf("Opening &amp; UTR delays · reason only"));
assert.ok(html.includes('name="corrective_action"') && html.includes("Edit RCA &amp; plan") && html.includes("Add reason"));
assert.equal((html.match(/name="corrective_action"/g)??[]).length,1,"only a performance miss needs an action plan; delay rows stay reason-only");
console.log("PASS Discipline RCA: exact staff IDs, late-only exceptions, short reasons, scope/role guards, trusted evidence, saved reason completion gate, compact/read-only forms.");

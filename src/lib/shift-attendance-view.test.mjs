import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
function load(file, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", code)(name => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}
const view = load("./shift-attendance-view.ts");
const credit = load("./wfh-attendance-credit.ts");
const exp = load("./shift-attendance-export.ts", { "@/lib/shift-attendance-view": view });
const day = "2026-09-24", now = Date.parse(day + "T20:00:00+05:30");
const person = (today = {}) => ({ name: "Test", code: "D001", designation: "Executive", locationId: "HO", availability: "Completed", today: {
  reported: true, lateMinutes: 10, earlyMinutes: 30, workMinutes: 480, missingPunch: false,
  inTime: day + "T09:10:00+05:30", outTime: day + "T17:30:00+05:30", shiftName: "Day", rosterDayType: "working",
  ...view.shiftBounds(day, "09:00:00", "18:00:00"), ...today } });
test("late and early are independent", () => { assert(view.matchesShift(person(), "late")); assert(view.matchesShift(person(), "early")); assert.equal(view.shiftLabel(person(), now), "Late in 10m · Early out 30m"); });
test("WFH is never missing attendance", () => { const p = person({ reported: false, inTime: null, outTime: null, workMode: "wfh", wfhState: "credited" }); assert(!view.matchesShift(p, "missing")); assert(!view.matchesShift(p, "late")); assert.equal(view.shiftLabel(p), "WFH · credited"); });
test("approved leave and week off remain visible", () => { assert.equal(view.shiftLabel(person({ approvedLeave: true })), "Approved leave · punched"); assert(view.matchesShift(person({ rosterDayType: "weekly_off" }), "off")); });
test("unrostered is not absent", () => assert.equal(view.shiftCategory(person({ reported: false, shiftName: null, rosterDayType: null })), "unassigned"));
test("QLDA: five scheduled, four upcoming, one due and two pending HR", () => {
  const morning = Date.parse("2026-10-06T06:00:00+05:30");
  const rows = ["04:00:00","08:00:00","09:00:00","13:30:00","13:30:00"].map(start => person({
    ...view.shiftBounds("2026-10-06", start, "22:30:00"), reported: false, lateMinutes: 0, inTime: null, outTime: null
  }));
  rows.push(...[1,2].map(() => person({ reported: false, shiftName: null, rosterDayType: null, rosterSetupStatus: "pending_approval", rosterSetupLabel: "Awaiting HR approval" })));
  assert.equal(rows.filter(view.isScheduledShift).length, 5);
  assert.equal(rows.filter(p => view.matchesShift(p, "upcoming", "", morning)).length, 4);
  assert.equal(rows.filter(p => view.matchesShift(p, "missing", "", morning)).length, 1);
  assert.equal(rows.filter(p => view.matchesShift(p, "pending", "", morning)).length, 2);
  assert.equal(view.shiftLabel(rows[5], morning), "Awaiting HR approval");
});
test("pending changes do not hide an approved baseline or count as week off", () => {
  const approved = person({ rosterSetupStatus: "pending_approval", rosterSetupLabel: "Awaiting HR approval" });
  assert(view.isScheduledShift(approved)); assert.notEqual(view.shiftCategory(approved, now), "pending");
  const pending = person({ reported: false, shiftName: null, rosterDayType: null, rosterSetupStatus: "pending_approval" });
  assert(!view.isScheduledShift(pending)); assert(!view.matchesShift(pending, "off", "", now)); assert(!view.matchesShift(pending, "missing", "", now));
});
test("approved leave, WFH and week off are not expected onsite", () => {
  for (const today of [{approvedLeave:true}, {workMode:"wfh"}, {workMode:"business_trip"}, {rosterDayType:"weekly_off"}]) assert(!view.isScheduledShift(person(today)));
});
test("roster setup distinguishes submitted, draft and genuinely missing", () => {
  const rows = [person({shiftName:null,rosterDayType:null}), person({shiftName:null,rosterDayType:null,rosterSetupStatus:"draft"})];
  assert.equal(view.rosterSetupSummary(rows), "1 roster awaiting completion / approval · 1 without a roster");
});
test("missing punch is only overdue after shift end", () => { const p = person({ outTime: null, missingPunch: true }); assert(!view.matchesShift(p, "single", "", Date.parse(day + "T12:00:00+05:30"))); assert(view.matchesShift(p, "single", "", now)); });
test("overnight end and early morning positions keep the real date", () => { assert.equal(view.shiftBounds(day, "22:00:00", "06:00:00").shiftEndsAt, "2026-09-25T00:30:00.000Z"); assert.equal(view.shiftPunchMinute(day + "T02:28:00+05:30", day), 148); });
test("early out ignores punch seconds consistently with People", () => { const end = view.shiftPunchMinute(day + "T16:00:00+05:30", day); const out = view.shiftPunchMinute(day + "T15:55:42+05:30", day); assert.equal(end - out, 5); });
test("WFH is credited only after finalization", () => { const r = { work_mode: "wfh", wfh_scheduled_start_at: day + "T09:00:00+05:30", wfh_scheduled_end_at: day + "T18:00:00+05:30" }; assert.equal(credit.wfhCreditState(r, now), "awaiting_finalization"); });
test("Excel contains filtered rows and numeric exceptions", () => { const xlsx = require("xlsx"); const wb = xlsx.read(exp.shiftAttendanceWorkbook([person()], day, new Map([["HO","HO"]]), "early", ""), { type: "array" }); const rows = xlsx.utils.sheet_to_json(wb.Sheets["Shift attendance"]); assert.equal(rows.length, 1); assert.equal(rows[0]["Early out minutes"], 30); });

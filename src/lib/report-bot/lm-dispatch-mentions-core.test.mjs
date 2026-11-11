import test from "node:test";
import assert from "node:assert/strict";
import { attendanceWorkerKey, lastShiftWorkerKeys, normalizeWhatsAppNumber, presentWorkerKeys, teamLeaderMentionNumbers } from "./lm-dispatch-mentions-core.ts";

const key = attendanceWorkerKey("employee", "E1");
const expected = new Map([[key, "S1"]]);
const punch = (overrides = {}) => ({ workerType:"employee", workerId:"E1", locationId:"S1", punchLabel:"In1", punchTime:"2026-11-08T08:00:00+05:30", source:"biometric", id:"1", ...overrides });

test("normalizes Indian numbers for WhatsApp", () => {
  assert.equal(normalizeWhatsAppNumber("98765 43210"), "919876543210");
  assert.equal(normalizeWhatsAppNumber("+91 98765 43210"), "919876543210");
  assert.equal(normalizeWhatsAppNumber("123"), null);
});

test("latest biometric In at the current station is present", () => {
  assert.deepEqual([...presentWorkerKeys([punch()], expected)], [key]);
});

test("latest Out excludes the worker", () => {
  assert.equal(presentWorkerKeys([punch(), punch({punchLabel:"Out1",punchTime:"2026-11-08T17:00:00+05:30",id:"2"})], expected).size, 0);
});

test("manual In and old-station In are excluded", () => {
  assert.equal(presentWorkerKeys([punch({source:"manual"})], expected).size, 0);
  assert.equal(presentWorkerKeys([punch({locationId:"OLD"})], expected).size, 0);
});

test("latest station shift remains tagged after biometric Out",()=>{
  assert.deepEqual([...lastShiftWorkerKeys([punch(),punch({punchLabel:"Out1",punchTime:"2026-11-08T18:00:00+05:30",id:"2"})],expected)],[key]);
});

test("latest station shift excludes an earlier shift when a later shift exists",()=>{
  const second=attendanceWorkerKey("employee","E2");
  const locations=new Map([[key,"S1"],[second,"S1"]]);
  const rows=[punch(),punch({punchLabel:"Out1",punchTime:"2026-11-08T12:00:00+05:30",id:"2"}),punch({workerId:"E2",punchTime:"2026-11-08T14:00:00+05:30",id:"3"}),punch({workerId:"E2",punchLabel:"Out1",punchTime:"2026-11-08T18:00:00+05:30",id:"4"})];
  assert.deepEqual([...lastShiftWorkerKeys(rows,locations)],[second]);
});

test("recognition tags only People Team Leaders in the selected stations", () => {
  const person = (overrides = {}) => ({ role: "Team Leader", roleCode: "TL", locationId: "S1", phone: "9876543210", ...overrides });
  assert.deepEqual(teamLeaderMentionNumbers([
    person(), person({ phone: "+91 98765 43210" }),
    person({ role: "Team Lead", roleCode: "TEAM_LEAD", locationId: "S2", phone: "9876543211" }),
    person({ role: "Cluster Manager", roleCode: "CM", phone: "9876543212" }),
    person({ role: "Area Operations Manager", roleCode: "AOM", phone: "9876543213" }),
    person({ role: "Assistant Team Leader", roleCode: "ATL", phone: "9876543214" }),
    person({ locationId: "OTHER", phone: "9876543215" }),
    person({ phone: null }),
  ], ["S1", "S2"]), ["919876543210", "919876543211"]);
});

test("missing Team Leader never falls back to a cluster manager", () => {
  assert.deepEqual(teamLeaderMentionNumbers([
    { role: "Cluster Manager", roleCode: "CM", locationId: "S1", phone: "9876543212" },
  ], ["S1"]), []);
});

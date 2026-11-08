import test from "node:test";
import assert from "node:assert/strict";
import { attendanceWorkerKey, normalizeWhatsAppNumber, presentWorkerKeys } from "./lm-dispatch-mentions-core.ts";

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

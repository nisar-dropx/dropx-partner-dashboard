import test from "node:test";
import assert from "node:assert/strict";
import { partnerReportStillBlocksWorkspace } from "./partner-onboarding.ts";

const locked = {
  accountStatus: "Active",
  mappingConfirmed: false,
  registrationReady: true,
  reportDate: "2026-09-13",
  restrictDropxOne: true,
  today: "2026-10-04"
};

test("an active associate is not locked by a partner report older than the background-check SLA", () => {
  assert.equal(partnerReportStillBlocksWorkspace(locked), false);
});

test("a fresh background-check report still keeps a new associate on work setup", () => {
  assert.equal(partnerReportStillBlocksWorkspace({ ...locked, reportDate: "2026-10-02", accountStatus: "Pending" }), true);
  assert.equal(partnerReportStillBlocksWorkspace({ ...locked, reportDate: "2026-10-02" }), true);
});

test("a confirmed provider mapping opens the workspace", () => {
  assert.equal(partnerReportStillBlocksWorkspace({ ...locked, mappingConfirmed: true, reportDate: "2026-10-04" }), false);
});

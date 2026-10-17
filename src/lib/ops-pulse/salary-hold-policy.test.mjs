import assert from "node:assert/strict";
import test from "node:test";
import { approverActions, holdApprovers, noteError, requesterActions, validateRaise } from "./salary-hold-policy.ts";

const hold = (status, extra = {}) => ({ status, requestedBy: "mgr", cancelRequestedBy: null, releaseRequestedBy: null, ...extra });

test("the raiser can withdraw, request cancellation or request release, nothing else", () => {
  assert.deepEqual(requesterActions("awaiting_approval"), ["withdraw"]);
  assert.deepEqual(requesterActions("pending"), ["request_cancel"]);
  assert.deepEqual(requesterActions("applied"), ["request_release"]);
  for (const s of ["rejected", "cancelled", "released", "cancel_requested", "release_requested"]) assert.deepEqual(requesterActions(s), []);
});

test("approvers decide open requests but never their own", () => {
  assert.deepEqual(approverActions(hold("awaiting_approval"), "cm", true), ["approve", "reject"]);
  assert.deepEqual(approverActions(hold("awaiting_approval"), "mgr", true), []);
  assert.deepEqual(approverActions(hold("awaiting_approval"), "cm", false), []);
  assert.deepEqual(approverActions(hold("cancel_requested", { cancelRequestedBy: "mgr" }), "cm", true), ["approve_cancel", "reject_cancel"]);
  assert.deepEqual(approverActions(hold("release_requested", { releaseRequestedBy: "cm" }), "cm", true), []);
  assert.deepEqual(approverActions(hold("release_requested", { releaseRequestedBy: "mgr" }), "cm", true), ["approve_release", "reject_release"]);
  assert.deepEqual(approverActions(hold("applied"), "cm", true), []);
});

test("cluster managers approve; AOMs only when no cluster manager is mapped", () => {
  const p = (personId, name) => ({ personId, name });
  assert.deepEqual(holdApprovers({ clusterManagers: [p("c1", "CM")], areaOperationsManagers: [p("a1", "AOM")] }), { level: "cluster_manager", personIds: ["c1"], names: ["CM"] });
  assert.deepEqual(holdApprovers({ clusterManagers: [], areaOperationsManagers: [p("a1", "AOM")] }), { level: "aom", personIds: ["a1"], names: ["AOM"] });
  assert.deepEqual(holdApprovers(undefined), { level: "none", personIds: [], names: [] });
  // A cluster manager who raised the hold never approves it; it moves to the AOM.
  assert.deepEqual(holdApprovers({ clusterManagers: [p("c1", "CM")], areaOperationsManagers: [p("a1", "AOM")] }, new Set(["c1"])), { level: "aom", personIds: ["a1"], names: ["AOM"] });
  assert.deepEqual(holdApprovers({ clusterManagers: [p("c1", "CM"), p("c2", "CM2")] }, new Set(["c1"])), { level: "cluster_manager", personIds: ["c2"], names: ["CM2"] });
  // Acting cover replaces an unavailable AOM (or CM) with the next person.
  assert.deepEqual(
    holdApprovers({ clusterManagers: [], areaOperationsManagers: [p("a1", "AOM")] }, new Set(), new Map([["a1", p("h1", "Head")]])),
    { level: "aom", personIds: ["h1"], names: ["Head"] },
  );
});

test("raise validation matches the database", () => {
  const ok = { holdType: "amount", amount: "500", days: "", reason: "Cash shortage" };
  assert.equal(validateRaise(ok), "");
  assert.match(validateRaise({ ...ok, amount: "0" }), /hold amount/);
  assert.match(validateRaise({ ...ok, amount: "1.234" }), /hold amount/);
  assert.match(validateRaise({ ...ok, amount: "2000000" }), /hold amount/);
  assert.equal(validateRaise({ ...ok, holdType: "days", days: "1.5" }), "");
  assert.match(validateRaise({ ...ok, holdType: "days", days: "0.3" }), /half days/);
  assert.match(validateRaise({ ...ok, holdType: "days", days: "32" }), /half days/);
  assert.match(validateRaise({ ...ok, reason: "bad" }), /reason/);
  assert.match(validateRaise({ ...ok, holdType: "x" }), /amount or a number of days/);
});

test("notes are required where a decision goes against the request", () => {
  assert.equal(noteError("approve", ""), "");
  assert.match(noteError("reject", "no"), /at least 5/);
  assert.match(noteError("request_release", ""), /at least 5/);
  assert.match(noteError("approve", "x".repeat(501)), /under 500/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRosterPendencySnapshot,
  rosterAgeDays,
  rosterStatusLabel,
  rosterWaitingOn,
  uniqueManagerEmail
} from "./roster-pendency.ts";
import { buildRosterPendencyMessages } from "./roster-pendency-digest.ts";

test("status and waiting-on labels cover draft, returned and approval stages", () => {
  assert.equal(rosterStatusLabel("draft"), "Draft · not submitted");
  assert.equal(rosterWaitingOn("draft", null), "Station planner must submit");
  assert.equal(rosterWaitingOn("returned", null), "Station planner must fix and resubmit");
  assert.equal(rosterWaitingOn("pending_approval", "level_1"), "Station manager approval");
  assert.equal(rosterWaitingOn("pending_approval", "level_2"), "Cluster / next manager approval");
  assert.equal(rosterWaitingOn("pending_approval", "hr"), "HR approval");
});

test("age days are non-negative calendar days in IST date strings", () => {
  assert.equal(rosterAgeDays("2026-10-30", "2026-10-28T10:00:00Z"), 2);
  assert.equal(rosterAgeDays("2026-10-30", null), 0);
  assert.equal(rosterAgeDays("2026-10-30", "2026-11-01"), 0);
});

test("unique manager email rejects ambiguity", () => {
  assert.equal(uniqueManagerEmail(["a@dropxlogistics.com", "A@DropXLogistics.com"]), "a@dropxlogistics.com");
  assert.equal(uniqueManagerEmail(["a@dropxlogistics.com", "b@dropxlogistics.com"]), null);
});

test("snapshot drops empty recipients and rejects duplicate emails", () => {
  const row = {
    key: "plan-1",
    planId: "plan-1",
    stationId: "st-1",
    stationCode: "TCC3",
    stationName: "Test",
    status: "pending_approval",
    statusLabel: "Awaiting approval",
    periodStart: "2026-10-27",
    periodEnd: "2026-11-02",
    revisionNo: 1,
    waitingOn: "Station manager approval",
    ageDays: 1,
    submittedAt: "2026-10-29T00:00:00Z"
  };
  const snapshot = buildRosterPendencySnapshot({
    date: "2026-10-30",
    checkedAt: "2026-10-30T02:30:00.000Z",
    rows: [row],
    recipients: [
      { email: "sm@dropxlogistics.com", name: "Station Manager", roles: ["Station manager"], stationIds: ["st-1"], planKeys: ["plan-1"] },
      { email: "empty@dropxlogistics.com", name: "Empty", roles: ["Cluster manager"], stationIds: ["st-2"], planKeys: ["missing"] }
    ]
  });
  assert.equal(snapshot.recipients.length, 1);
  assert.equal(snapshot.recipients[0].email, "sm@dropxlogistics.com");
  assert.throws(() => buildRosterPendencySnapshot({
    date: "2026-10-30",
    checkedAt: "2026-10-30T02:30:00.000Z",
    rows: [row],
    recipients: [
      { email: "same@dropxlogistics.com", name: "A", roles: ["Station manager"], stationIds: ["st-1"], planKeys: ["plan-1"] },
      { email: "SAME@dropxlogistics.com", name: "B", roles: ["Cluster manager"], stationIds: ["st-1"], planKeys: ["plan-1"] }
    ]
  }), /Conflicting roster reminder recipients/);
});

test("message builder produces one polished email per recipient and no zero-pendency mail", () => {
  const snapshot = buildRosterPendencySnapshot({
    date: "2026-10-30",
    checkedAt: "2026-10-30T02:30:00.000Z",
    rows: [{
      key: "plan-1",
      planId: "plan-1",
      stationId: "st-1",
      stationCode: "TCC3",
      stationName: "Thrissur",
      status: "returned",
      statusLabel: "Returned · resubmit needed",
      periodStart: "2026-10-27",
      periodEnd: "2026-11-02",
      revisionNo: 2,
      waitingOn: "Station planner must fix and resubmit",
      ageDays: 3,
      submittedAt: null
    }],
    recipients: [{
      email: "cm@dropxlogistics.com",
      name: "Cluster Lead",
      roles: ["Cluster manager"],
      stationIds: ["st-1"],
      planKeys: ["plan-1"]
    }]
  });
  const messages = buildRosterPendencyMessages(snapshot, "DropX | Roster pending | Morning | {{date}}");
  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /2026-10-30/);
  assert.match(messages[0].html, /Roster pending at your stations/);
  assert.match(messages[0].html, /TCC3/);
  assert.match(messages[0].html, /Returned/);
  assert.deepEqual(messages[0].scope.planIds, ["plan-1"]);
  assert.equal(buildRosterPendencyMessages({ ...snapshot, recipients: [] }, "DropX | Roster pending | Morning | {{date}}").length, 0);
});

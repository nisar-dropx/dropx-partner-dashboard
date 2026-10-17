import test from "node:test";
import assert from "node:assert/strict";
import {
  auditDraftContentScore,
  preferAuditDraft,
} from "./audit-draft.ts";

const draft = (savedAt, fields, extra = {}) => ({ savedAt, fields, extra });

test("content score counts filled values and shipments", () => {
  assert.equal(auditDraftContentScore(null), 0);
  assert.equal(auditDraftContentScore(draft("2026-10-17T10:00:00.000Z", [])), 0);
  assert.equal(
    auditDraftContentScore(
      draft("2026-10-17T10:00:00.000Z", [
        { name: "a", index: 0, value: "yes" },
        { name: "b", index: 0, value: "  " },
        { name: "c", index: 0, checked: true },
      ], { shipments: [{ id: 1 }], tidRemarks: '{"x":"note"}' }),
    ),
    4,
  );
});

test("preferAuditDraft never lets a blank newer copy replace answers", () => {
  const filled = draft("2026-10-17T08:00:00.000Z", [
    { name: "q1", index: 0, value: "pass" },
  ]);
  const blankNewer = draft("2026-10-17T12:00:00.000Z", [
    { name: "q1", index: 0, value: "" },
  ]);
  assert.equal(preferAuditDraft(filled, blankNewer), filled);
  assert.equal(preferAuditDraft(blankNewer, filled), filled);
});

test("preferAuditDraft still takes the newer copy when both have answers", () => {
  const older = draft("2026-10-17T08:00:00.000Z", [
    { name: "q1", index: 0, value: "pass" },
  ]);
  const newer = draft("2026-10-17T12:00:00.000Z", [
    { name: "q1", index: 0, value: "gap" },
  ]);
  assert.equal(preferAuditDraft(older, newer), newer);
  assert.equal(preferAuditDraft(newer, older), newer);
});

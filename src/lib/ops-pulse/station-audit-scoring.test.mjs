import assert from "node:assert/strict";
import test from "node:test";
import {
  auditAssessmentSubject,
  calculateAuditScore,
} from "./station-audit-scoring.ts";

test("responsibility validation names the checklist label, not the raw key", () => {
  assert.equal(auditAssessmentSubject("cash"), "COD difference");
  assert.equal(
    auditAssessmentSubject("check:b1ef68cc-43aa-467c-99aa-ab05c48eeb5f", [
      {
        id: "b1ef68cc-43aa-467c-99aa-ab05c48eeb5f",
        label: "Washrooms to be in hygiene condition",
      },
    ]),
    "Washrooms to be in hygiene condition",
  );
  assert.equal(
    auditAssessmentSubject("TID-1"),
    "tracking ID TID-1",
  );
});

test("non-pending responsibility without a reason fails with the checklist label", () => {
  assert.throws(
    () =>
      calculateAuditScore({
        sections: [{ id: "hygiene", name: "Hygiene", score_weight: 100 }],
        items: [
          {
            id: "b1ef68cc-43aa-467c-99aa-ab05c48eeb5f",
            section_id: "hygiene",
            label: "Washrooms to be in hygiene condition",
            score_weight: 1,
            response_options: [
              { value: "poor", label: "Poor", score: 0 },
            ],
          },
        ],
        responses: {
          "b1ef68cc-43aa-467c-99aa-ab05c48eeb5f": "poor",
        },
        options: [
          {
            code: "controllable",
            label: "Within station control",
            metadata: { exclude_from_score: false, pending: false },
          },
          {
            code: "pending",
            label: "Responsibility pending investigation",
            metadata: { exclude_from_score: false, pending: true },
          },
        ],
        expectedCash: 0,
        actualCash: 0,
        expectedTids: [],
        scannedTids: [],
        assessments: {
          "check:b1ef68cc-43aa-467c-99aa-ab05c48eeb5f": {
            code: "controllable",
            reason: "",
            evidenceId: "",
          },
        },
        evidenceIds: [],
      }),
    /Add the responsibility reason for Washrooms to be in hygiene condition/,
  );
});

test("pending responsibility does not require a reason and keeps the report provisional", () => {
  const snapshot = calculateAuditScore({
    sections: [{ id: "hygiene", name: "Hygiene", score_weight: 100 }],
    items: [
      {
        id: "b1ef68cc-43aa-467c-99aa-ab05c48eeb5f",
        section_id: "hygiene",
        label: "Washrooms to be in hygiene condition",
        score_weight: 1,
        response_options: [{ value: "poor", label: "Poor", score: 0 }],
      },
    ],
    responses: { "b1ef68cc-43aa-467c-99aa-ab05c48eeb5f": "poor" },
    options: [
      {
        code: "pending",
        label: "Responsibility pending investigation",
        metadata: { exclude_from_score: false, pending: true },
      },
      {
        code: "fantastic",
        label: "Fantastic",
        metadata: { minimum_score: 90 },
      },
      {
        code: "poor",
        label: "Poor",
        metadata: { minimum_score: 0 },
      },
    ],
    expectedCash: 0,
    actualCash: 0,
    expectedTids: [],
    scannedTids: [],
    assessments: {
      "check:b1ef68cc-43aa-467c-99aa-ab05c48eeb5f": {
        code: "pending",
        reason: "",
        evidenceId: "",
      },
    },
    evidenceIds: [],
  });
  assert.equal(snapshot.provisional, true);
  assert.equal(
    snapshot.assessments["check:b1ef68cc-43aa-467c-99aa-ab05c48eeb5f"].pending,
    true,
  );
});

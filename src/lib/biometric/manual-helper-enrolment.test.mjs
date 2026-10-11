import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync(new URL("../../app/people/category/[code]/actions.ts", import.meta.url), "utf8");

test("manual helper creation creates its biometric enrolment", () => {
  const createStart = actions.indexOf("export async function createDynamicWorkforceProfile");
  const updateStart = actions.indexOf("export async function updateDynamicWorkforceProfile");
  const createAction = actions.slice(createStart, updateStart);

  assert.match(createAction, /if \(code === "helpers"\) \{[\s\S]*?await syncBiometricEnrolment\(\{/);
  assert.match(createAction, /accountId: insertResult\.data\.id/);
  assert.match(createAction, /effectiveFrom: dateOfJoin/);
  assert.match(createAction, /enrolmentId: biometricId/);
  assert.match(createAction, /profileType: "worker"/);
});

test("manual helper updates keep biometric identity, location, date, and status synchronized", () => {
  const updateStart = actions.indexOf("export async function updateDynamicWorkforceProfile");
  const updateAction = actions.slice(updateStart);

  assert.match(updateAction, /if \(code === "helpers"\) \{[\s\S]*?await syncBiometricEnrolment\(\{/);
  assert.match(updateAction, /accountId: id/);
  assert.match(updateAction, /effectiveFrom: String\(payload\.date_of_join \?\? existing\.date_of_join \?\? ""\)/);
  assert.match(updateAction, /enrolmentId: String\(existing\.biometric_id \?\? ""\) \|\| null/);
  assert.match(updateAction, /isActive: Boolean\(payload\.is_active\)/);
  assert.match(updateAction, /locationId,/);
  assert.match(updateAction, /profileType: "worker"/);
});

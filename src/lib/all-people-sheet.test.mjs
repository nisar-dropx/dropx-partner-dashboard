import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_PEOPLE_SHEET_EDITABLE_KEYS,
  buildAllPeopleSheetPatch
} from "./all-people-sheet.ts";

const employee = { employeeColumns: true };
const nonEmployee = { employeeColumns: false };

test("builds a minimal patch containing only the changed canonical fields", () => {
  const result = buildAllPeopleSheetPatch({
    fullName: "  Jane Doe  ",
    email: "  JANE@EXAMPLE.COM "
  }, employee);

  assert.deepEqual(result, {
    canonicalValues: {
      fullName: "Jane Doe",
      email: "jane@example.com"
    },
    changedKeys: ["fullName", "email"],
    deferred: {},
    payload: {
      full_name: "Jane Doe",
      email: "jane@example.com"
    }
  });
  assert.ok(!("mobile" in result.payload), "an unchanged mobile must not be sent");
  assert.ok(!("date_of_join" in result.payload), "an unchanged join date must not be sent");
  assert.ok(!("bank_account_no" in result.payload), "an unchanged bank account must not be sent");
});

test("maps category-specific pincode and IFSC columns without touching sibling columns", () => {
  const employeePatch = buildAllPeopleSheetPatch({
    pincode: "682 001",
    ifsc: "hdfc0abc123"
  }, employee);
  assert.deepEqual(employeePatch.payload, {
    pincode: "682001",
    ifsc: "HDFC0ABC123"
  });
  assert.ok(!("postal_pin" in employeePatch.payload));
  assert.ok(!("ifsc_code" in employeePatch.payload));

  const contractorPatch = buildAllPeopleSheetPatch({
    pincode: "682001",
    ifsc: "hdfc0abc123"
  }, nonEmployee);
  assert.deepEqual(contractorPatch.payload, {
    postal_pin: "682001",
    ifsc_code: "HDFC0ABC123"
  });
  assert.ok(!("pincode" in contractorPatch.payload));
  assert.ok(!("ifsc" in contractorPatch.payload));
});

test("defers location and designation for scoped master-record resolution", () => {
  const result = buildAllPeopleSheetPatch({
    location: " ERSE ",
    designation: " Team Lead "
  }, employee);

  assert.deepEqual(result.payload, {});
  assert.deepEqual(result.deferred, {
    location: "ERSE",
    designation: "Team Lead"
  });
  assert.deepEqual(result.changedKeys, ["location", "designation"]);
});

test("keeps linked and identity fields outside the writable allowlist", () => {
  assert.ok(!ALL_PEOPLE_SHEET_EDITABLE_KEYS.includes("model"));
  assert.ok(!ALL_PEOPLE_SHEET_EDITABLE_KEYS.includes("provider"));
  assert.ok(!ALL_PEOPLE_SHEET_EDITABLE_KEYS.includes("dropxId"));

  for (const field of ["model", "provider", "dropxId", "createdAt"]) {
    assert.throws(
      () => buildAllPeopleSheetPatch({ [field]: "changed" }, employee),
      /read-only or is not a supported sheet field/
    );
  }
});

test("normalizes dates, booleans, identifiers, and explicit clearing", () => {
  const result = buildAllPeopleSheetPatch({
    dateOfJoin: "26/09/2026",
    active: "Yes",
    handicapped: "No",
    aadhaarNumber: "1234 5678 9012",
    panNumber: "abcde1234f",
    statutoryApplicability: "PF, ESI",
    returnRemarks: ""
  }, employee);

  assert.deepEqual(result.payload, {
    date_of_join: "2026-09-26",
    is_active: true,
    is_handicapped: false,
    aadhaar_number: "123456789012",
    pan_number: "ABCDE1234F",
    statutory_applicability: ["pf", "esi"],
    profile_return_remarks: null
  });
  assert.deepEqual(result.canonicalValues, {
    dateOfJoin: "26/09/2026",
    active: "Yes",
    handicapped: "No",
    aadhaarNumber: "123456789012",
    panNumber: "ABCDE1234F",
    statutoryApplicability: "pf, esi",
    returnRemarks: ""
  });
});

test("rejects empty, malformed, and non-text changes before database access", () => {
  assert.throws(() => buildAllPeopleSheetPatch({}, employee), /no changes to save/i);
  assert.throws(() => buildAllPeopleSheetPatch({ fullName: "" }, employee), /Full name is required/);
  assert.throws(() => buildAllPeopleSheetPatch({ email: "not-an-email" }, employee), /Email format is invalid/);
  assert.throws(() => buildAllPeopleSheetPatch({ dateOfJoin: "31\/02\/2026" }, employee), /valid date of join/);
  assert.throws(() => buildAllPeopleSheetPatch({ mobileNumber: "" }, employee), /Mobile number is required/);
  assert.throws(() => buildAllPeopleSheetPatch({ dateOfJoin: "" }, employee), /Date of join is required/);
  assert.throws(() => buildAllPeopleSheetPatch({ active: "" }, employee), /Active is required/);
  assert.throws(() => buildAllPeopleSheetPatch({ fullName: 123 }, employee), /must be a text value/);
});

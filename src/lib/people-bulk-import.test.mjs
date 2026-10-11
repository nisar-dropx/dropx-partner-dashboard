import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniquePeopleBulkIdentities,
  normalizePeopleBulkBiometricId,
  normalizePeopleBulkDropxId,
  parsePeopleBulkBankDetails,
  peopleBulkImportLifecycle
} from "./people-bulk-import.ts";

test("normalizes bulk identities the same way as the database uniqueness policy", () => {
  assert.equal(normalizePeopleBulkDropxId(" d 08 26 "), "D0826");
  assert.equal(normalizePeopleBulkBiometricId("00042"), "42");
  assert.equal(normalizePeopleBulkBiometricId("000"), "0");
  assert.throws(() => normalizePeopleBulkBiometricId("42A"), /1 to 20 digits/);
});

test("rejects normalized duplicate DropX and biometric IDs inside one workbook", () => {
  assert.throws(() => assertUniquePeopleBulkIdentities([
    { rowNumber: 2, dropxId: "D 0826", biometricId: "0042" },
    { rowNumber: 7, dropxId: "d0826", biometricId: "99" }
  ]), /Rows 2 and 7: DropX ID D0826/);

  assert.throws(() => assertUniquePeopleBulkIdentities([
    { rowNumber: 3, dropxId: "D0826", biometricId: "0042" },
    { rowNumber: 8, dropxId: "D0827", biometricId: "42" }
  ]), /Rows 3 and 8: Biometric ID 42/);
});

test("Helpers activate immediately while Workforce retains its review lifecycle", () => {
  assert.deepEqual(peopleBulkImportLifecycle("worker"), { isActive: true, onboardingStatus: "active" });
  assert.deepEqual(peopleBulkImportLifecycle("field_executive"), { isActive: false, onboardingStatus: "pending" });
  assert.deepEqual(peopleBulkImportLifecycle("contractor"), { isActive: true, onboardingStatus: "pending" });
});

test("bank details preserve text identifiers and reject Excel-rounded numeric accounts", () => {
  assert.deepEqual(parsePeopleBulkBankDetails("001234567890123456", "hdfc0001234", 2), {
    bankAccountNo: "001234567890123456",
    ifscCode: "HDFC0001234"
  });
  assert.throws(
    () => parsePeopleBulkBankDetails(123456789012345680, "HDFC0001234", 4),
    /Row 4: Format the Bank account number cell as Text/
  );
  assert.throws(() => parsePeopleBulkBankDetails("12345678", "", 5), /entered together/);
});

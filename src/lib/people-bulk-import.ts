export const PEOPLE_BULK_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const PEOPLE_BULK_IMPORT_MAX_ROWS = 1000;
export const HELPER_BULK_IMPORT_MAX_ROWS = 200;

export type PeopleBulkIdentityRow = {
  biometricId: string | null;
  dropxId: string | null;
  rowNumber: number;
};

export function normalizePeopleBulkDropxId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export function normalizePeopleBulkBiometricId(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^\d{1,20}$/.test(text)) throw new Error("Biometric ID must contain 1 to 20 digits.");
  return text.replace(/^0+/, "") || "0";
}

export function assertUniquePeopleBulkIdentities(rows: PeopleBulkIdentityRow[]) {
  const dropxRows = new Map<string, PeopleBulkIdentityRow>();
  const biometricRows = new Map<string, PeopleBulkIdentityRow>();

  for (const row of rows) {
    const dropxId = normalizePeopleBulkDropxId(row.dropxId);
    if (dropxId) {
      const previous = dropxRows.get(dropxId);
      if (previous) {
        throw new Error(`Rows ${previous.rowNumber} and ${row.rowNumber}: DropX ID ${dropxId} is duplicated in the Excel file.`);
      }
      dropxRows.set(dropxId, row);
    }

    const biometricId = normalizePeopleBulkBiometricId(row.biometricId);
    if (biometricId) {
      const previous = biometricRows.get(biometricId);
      if (previous) {
        throw new Error(`Rows ${previous.rowNumber} and ${row.rowNumber}: Biometric ID ${biometricId} is duplicated in the Excel file.`);
      }
      biometricRows.set(biometricId, row);
    }
  }
}

export function peopleBulkImportLifecycle(profileType: string) {
  if (profileType === "worker") {
    return { isActive: true, onboardingStatus: "active" as const };
  }
  if (profileType === "field_executive") {
    return { isActive: false, onboardingStatus: "pending" as const };
  }
  return { isActive: true, onboardingStatus: "pending" as const };
}

export function parsePeopleBulkBankDetails(accountValue: unknown, ifscValue: unknown, rowNumber: number) {
  const accountText = String(accountValue ?? "").trim();
  const ifscText = String(ifscValue ?? "").trim().toUpperCase();
  if (!accountText && !ifscText) return { bankAccountNo: null, ifscCode: null };
  if (!accountText || !ifscText) {
    throw new Error(`Row ${rowNumber}: Bank account number and IFSC must be entered together.`);
  }
  if (typeof accountValue === "number") {
    throw new Error(`Row ${rowNumber}: Format the Bank account number cell as Text so Excel does not round or remove digits.`);
  }
  const bankAccountNo = accountText.toUpperCase();
  if (!/^[A-Z0-9]{4,30}$/.test(bankAccountNo)) {
    throw new Error(`Row ${rowNumber}: Bank account number must contain 4 to 30 letters or digits.`);
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscText)) {
    throw new Error(`Row ${rowNumber}: Enter a valid 11-character IFSC.`);
  }
  return { bankAccountNo, ifscCode: ifscText };
}

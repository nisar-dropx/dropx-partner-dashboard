import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildImportTemplate, importTemplateKinds } from "./import-template.ts";

test("creates a usable two-sheet workbook for every supported upload", () => {
  for (const kind of importTemplateKinds) {
    const template = buildImportTemplate(kind);
    assert.match(template.fileName, /\.xlsx$/);
    const workbook = XLSX.read(template.bytes, { type: "buffer" });
    assert.deepEqual(workbook.SheetNames, ["Upload", "Instructions"]);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Upload, { header: 1, defval: "" });
    assert.ok(Array.isArray(rows[0]));
    assert.ok(rows[0].length >= 2);
    assert.equal(rows.length, 1);
  }
});

test("uses exact parser-compatible compensation headers", () => {
  const salary = XLSX.read(buildImportTemplate("employee_salary").bytes, { type: "buffer" });
  const salaryRows = XLSX.utils.sheet_to_json(salary.Sheets.Upload, { header: 1, defval: "" });
  assert.deepEqual(salaryRows[0], [
    "EmpCode", "BASIC", "HRA", "Conveyance/LTA", "Special", "Food", "Communication",
    "Other", "Total", "PF", "ESI", "CTC", "CTC/YR"
  ]);

  const contractor = XLSX.read(buildImportTemplate("contractor_remuneration").bytes, { type: "buffer" });
  const contractorRows = XLSX.utils.sheet_to_json(contractor.Sheets.Upload, { header: 1, defval: "" });
  assert.deepEqual(contractorRows[0], ["DropX ID", "Remuneration"]);
});

test("creates a Helper template with optional payment details and no PAN requirement", () => {
  const template = buildImportTemplate("helper");
  assert.equal(template.fileName, "DropX_Helper_Bulk_Upload_Template.xlsx");

  const workbook = XLSX.read(template.bytes, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Upload, { header: 1, defval: "" });
  assert.deepEqual(rows[0], [
    "DropX ID", "Biometric ID", "Full name", "Mob country code", "Mob no", "Email",
    "Date of join (DD/MM/YYYY)", "Location", "Designation code", "Bank account number", "IFSC"
  ]);

  const instructions = XLSX.utils.sheet_to_json(workbook.Sheets.Instructions, { header: 1, defval: "" }).flat().join(" ");
  assert.match(instructions, /activated immediately/i);
  assert.match(instructions, /PAN is not required/i);
  assert.match(instructions, /enter both together/i);
});


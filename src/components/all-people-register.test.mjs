import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./all-people-register.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("edit-sheet opens in view-only mode and gates field controls behind Edit", () => {
  assert.match(component, /\[sheetEditMode, setSheetEditMode\] = useState\(false\)/);
  assert.match(component, /sheetEditMode \? "Cancel editing" : "Edit"/);
  assert.match(component, /sheetEditMode && editable \?/);
  assert.match(component, /sheet-view-only-label[^\n]*>View only</);
});

test("dirty state is sparse, reversible, and visibly marks the row and changed cell", () => {
  assert.match(component, /Record<string, Partial<AllPeopleExportValues>>/);
  assert.match(component, /if \(value === baseValue\) delete patch\[key\]/);
  assert.match(component, /className=\{rowDirty \? "sheet-row-dirty"/);
  assert.match(component, /cellDirty \? "sheet-cell-dirty"/);
  assert.match(styles, /\.all-people-edit-sheet tr\.sheet-row-dirty\s*>\s*td\s*\{[^}]*background:\s*#fff7c2/s);
  assert.match(styles, /\.all-people-edit-sheet tr\.sheet-row-dirty\s*>\s*td\.sheet-cell-dirty\s*\{[^}]*background:\s*#ffd9a8/s);
});

test("row saves and Save all submit only sparse changed-field patches", () => {
  assert.match(component, /changes:\s*patch/);
  assert.doesNotMatch(component, /values:\s*valuesFor\(row\)/);
  assert.match(component, /async function saveAllRows\(\)/);
  assert.match(component, /for \(const target of targets\) await persistRow\(target\.row, target\.patch\)/);
  assert.match(component, /Save all\$\{dirtyRows\.length/);
  assert.match(component, /disabled=\{!dirtyRows\.length \|\| savingAll \|\| savingIds\.size > 0\}/);
  assert.match(component, /const savedPatch = "savedValues" in result \? result\.savedValues : patch/);
});

test("pagination defaults to 20 and offers 20, 50, 100, 500, and All in sheet mode", () => {
  assert.match(component, /useState<PageSize>\(20\)/);
  for (const size of [20, 50, 100, 500]) {
    assert.match(component, new RegExp(`value: ${size}, label: "${size}"`));
  }
  assert.match(component, /value: "all", label: "All"/);
  assert.match(component, /const sheetRows = visibleRows/);
  assert.match(component, /pageSize === "all"\s*\? filteredRows\s*:\s*filteredRows\.slice/);
});

test("provider and model remain read-only linked fields while location and designation are editable", () => {
  assert.match(component, /"dateOfJoin", "location", "designation"/);
  assert.match(component, /column\.key === "model" \|\| column\.key === "provider"/);
  assert.match(component, /Linked to location and updated automatically/);

  const editableDeclaration = component.match(/const editableKeys = new Set<AllPeopleExportKey>\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.ok(editableDeclaration.includes('"location"'));
  assert.ok(editableDeclaration.includes('"designation"'));
  assert.ok(!editableDeclaration.includes('"model"'));
  assert.ok(!editableDeclaration.includes('"provider"'));
});

test("designation editing is limited to options valid for the row category and save warnings remain visible", () => {
  assert.match(component, /option\.categoryCodes === undefined \|\| option\.categoryCodes\.includes\(row\.categoryCode\)/);
  assert.match(component, /result\.warning \?\? "Saved"/);
  assert.match(component, /sheet-save-warning/);
  assert.match(styles, /\.sheet-save-warning\s*\{/);
});

test("boolean fields always offer both Yes and No", () => {
  assert.match(component, /const yesNoOptions = \[/);
  assert.match(component, /value: "Yes", label: "Yes"/);
  assert.match(component, /value: "No", label: "No"/);
  assert.match(component, /column\.key === "active" \|\| column\.key === "handicapped"/);
});

test("fixed horizontal scrollbar mirrors the table scroll position", () => {
  assert.match(component, /aria-label="People sheet horizontal scrollbar"/);
  assert.match(component, /stickyScrollElement\.scrollLeft = tableWrapElement\.scrollLeft/);
  assert.match(component, /tableWrapElement\.scrollLeft = stickyScrollElement\.scrollLeft/);
  assert.match(component, /new ResizeObserver\(updateStickyScroll\)/);
  assert.match(styles, /\.all-people-sticky-scroll\s*\{/);
  assert.match(styles, /\.all-people-sticky-scroll\.visible\s*\{/);
});

test("edit sheet orders and freezes DropX ID and full name before the scrollable biometric ID", () => {
  assert.match(component, /const sheetLeadingKeys: AllPeopleExportKey\[\] = \["dropxId", "fullName", "biometricId"\]/);
  assert.match(component, /<thead><tr>\{sheetColumns\.map/);
  assert.match(component, /\{sheetColumns\.map\(\(column\) => \{/);
  assert.match(component, /colSpan=\{sheetColumns\.length \+ 1\}/);
  assert.match(styles, /\.all-people-edit-sheet th\.sheet-column-dropxId,[\s\S]*?left:\s*0;[\s\S]*?width:\s*140px;/);
  assert.match(styles, /\.all-people-edit-sheet th\.sheet-column-fullName,[\s\S]*?left:\s*140px;[\s\S]*?width:\s*210px;/);
  assert.match(styles, /td\.sheet-column-dropxId,[\s\S]*?td\.sheet-column-fullName\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?background:\s*#fff;/);
});

test("profile files use compact view-only icons without exposing storage paths", () => {
  for (const key of ["aadhaarFrontFile", "aadhaarBackFile", "panFile", "drivingLicenseFrontFile", "drivingLicenseBackFile", "profilePhotoFile"]) {
    assert.ok(component.includes(`"${key}"`));
  }
  assert.match(component, /\/api\/people\/all-profile-file\?\$\{params\.toString\(\)\}/);
  assert.match(component, /aria-label=\{`View \$\{column\.label\} for \$\{row\.fullName\}`\}/);
  assert.match(component, /<Eye aria-hidden="true" size=\{17\} \/>/);
  assert.match(component, /<iframe referrerPolicy="no-referrer" sandbox=""/);
  assert.match(component, /cellValue \? \([\s\S]*?sheet-file-view[\s\S]*?: <span className="sheet-cell-value">-<\/span>/);
  assert.match(styles, /\.sheet-file-view\s*\{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/);
});

test("dates, controlled dropdowns, and statutory multi-select tags use typed controls", () => {
  for (const key of ["dateOfJoin", "dateOfBirth", "drivingLicenseExpiry", "vehicleRegistrationExpiry", "vehicleInsuranceExpiry", "pollutionExpiry"]) {
    assert.ok(component.includes(`"${key}"`));
  }
  assert.match(component, /type=\{dateField \? "date" : "text"\}/);
  assert.match(component, /value=\{dateField \? toDateInputValue\(cellValue\) : cellValue\}/);
  assert.match(component, /column\.key === "gender"[\s\S]*?genderOptions/);
  assert.match(component, /column\.key === "bloodGroup"[\s\S]*?bloodGroupOptions/);
  assert.match(component, /column\.key === "stateCode"[\s\S]*?stateCodeOptions/);
  assert.match(component, /const bloodGroupOptions = \["A\+", "A-", "B\+", "B-", "AB\+", "AB-", "O\+", "O-"\]/);
  assert.match(component, /if \(nextValue === "not_applicable"\)[\s\S]*?onChange\("not_applicable"\)/);
  assert.match(component, /onChange\(next\.length \? next\.join\(", "\) : "not_applicable"\)/);
  assert.match(component, /className="sheet-statutory-tag"/);
});

test("sheet verification mirrors individual edit groups and persists provider results server-side", () => {
  assert.match(component, /employees: \{ pageCode: "employees", profileType: "employee" \}/);
  assert.match(component, /workforce: \{ pageCode: "delivery_associates", profileType: "field_executive" \}/);
  assert.match(component, /contractors: \{ pageCode: "contractors", profileType: "contractor" \}/);
  assert.match(component, /pan: \["fullName", "panNumber", "aadhaarNumber"\]/);
  assert.match(component, /bank: \["bankAccountNumber", "ifsc"\]/);
  assert.match(component, /dl: \["fullName", "drivingLicenseNumber", "dateOfBirth"\]/);
  assert.match(component, /fullName: \["pan", "dl", "pf_uan"\]/);
  assert.match(component, /if \(kind === "pan" && !result\.blockSubmit\) next\.push\(await request\("pan_aadhaar"\)\)/);
  assert.match(component, /onDerivedValue\("drivingLicenseExpiry"/);
  assert.match(component, /onDerivedValue\("vehicleRegistrationExpiry"/);
  assert.match(component, /Reverification required after this edit/);
  assert.match(component, /RC owner: \$\{result\.ownerName\}/);
  assert.match(component, /Fuel type: \$\{result\.fuelType\}/);
  assert.match(styles, /\.sheet-verification-note,[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*normal;/);
});

test("saved verification note overrides remain authoritative after edit and revert", () => {
  assert.match(component, /const note = groupDirty[\s\S]*?: verificationNoteOverrides\[rowId\]\?\.\[column\.key\] \?\? row\.verificationNotes\?\.\[column\.key\]/);
  assert.doesNotMatch(component, /for \(const field of verificationFields\[verificationKind\]\) delete rowNotes\[field\]/);
});

test("sticky Save column is opaque in header, normal rows, and dirty rows", () => {
  assert.match(component, /<th className="sheet-row-actions">Save<\/th>/);
  assert.match(styles, /\.all-people-edit-sheet \.sheet-row-actions\s*\{[\s\S]*?right:\s*0;[\s\S]*?background:\s*#fff;[\s\S]*?box-shadow:/);
  assert.match(styles, /\.all-people-edit-sheet thead \.sheet-row-actions\s*\{[\s\S]*?background:\s*#f8fafc;/);
  assert.match(styles, /tr\.sheet-row-dirty > td\.sheet-row-actions,[\s\S]*?background:\s*#fff7c2;/);
});

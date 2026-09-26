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
  assert.match(component, /option\.categoryCodes\.includes\(row\.categoryCode\)/);
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

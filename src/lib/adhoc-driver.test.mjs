import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function load(file) {
  const module = { exports: {} };
  new Function(
    "module",
    "exports",
    ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS }
    }).outputText
  )(module, module.exports);
  return module.exports;
}

const {
  peopleForAdhocDriverReason,
  alternateAdhocDriverLeaveReason,
  adhocDriverEmptyLeaveMessage,
  adhocDriverPersonFieldLabel,
  adhocDriverDetails
} = load("./adhoc-driver.ts");

const reasons = [
  { reason_key: "dcd_leave", label: "DCD DA on leave", designation_codes: ["DCD", "ODCD"] },
  { reason_key: "driver_leave", label: "Driver on leave", designation_codes: ["DR"] },
  { reason_key: "vehicle_service", label: "Vehicle service", designation_codes: [] }
];
const people = [
  { id: "1", full_name: "Shamnas", dropx_id: "DROPX2150", designation_code: "DCD" },
  { id: "2", full_name: "Mahesh", dropx_id: "KOZA5289", designation_code: "DR" },
  { id: "3", full_name: "Own Van", dropx_id: "ODCD1", designation_code: "ODCD" }
];

test("filters people by reason designation codes and ignores vehicle_service", () => {
  assert.deepEqual(
    peopleForAdhocDriverReason(people, reasons[0]).map((p) => p.dropx_id),
    ["DROPX2150", "ODCD1"]
  );
  assert.deepEqual(
    peopleForAdhocDriverReason(people, reasons[1]).map((p) => p.dropx_id),
    ["KOZA5289"]
  );
  assert.deepEqual(peopleForAdhocDriverReason(people, reasons[2]), []);
  assert.deepEqual(peopleForAdhocDriverReason(null, reasons[0]), []);
  assert.deepEqual(peopleForAdhocDriverReason(people, null), []);
  assert.deepEqual(peopleForAdhocDriverReason(people, { reason_key: "x", label: "x", designation_codes: undefined }), []);
});

test("KTUR-style empty Driver leave points at DCD DA alternate", () => {
  const kturPeople = people.filter((p) => p.designation_code === "DCD");
  const alternate = alternateAdhocDriverLeaveReason(reasons, kturPeople, "driver_leave");
  assert.equal(alternate?.reason_key, "dcd_leave");
  assert.match(
    adhocDriverEmptyLeaveMessage("driver_leave", "2026-11-08", alternate, 1),
    /No Drivers \(DR\).*1 eligible person is listed under DCD DA on leave/
  );
});

test("empty DCD leave can point at Driver leave when only DR exist", () => {
  const driversOnly = people.filter((p) => p.designation_code === "DR");
  const alternate = alternateAdhocDriverLeaveReason(reasons, driversOnly, "dcd_leave");
  assert.equal(alternate?.reason_key, "driver_leave");
  assert.match(
    adhocDriverEmptyLeaveMessage("dcd_leave", "2026-11-08", alternate, 2),
    /No DCD \/ ODCD.*2 eligible people are listed under Driver on leave/
  );
});

test("no alternate when station directory is empty or reason is vehicle service", () => {
  assert.equal(alternateAdhocDriverLeaveReason(reasons, [], "driver_leave"), null);
  assert.equal(alternateAdhocDriverLeaveReason(reasons, people, "vehicle_service"), null);
  assert.equal(alternateAdhocDriverLeaveReason(reasons, people, ""), null);
  assert.match(
    adhocDriverEmptyLeaveMessage("driver_leave", "2026-11-08", null, 0),
    /Check workforce home station or provider mapping/
  );
});

test("field labels stay specific and saved details still parse", () => {
  assert.equal(adhocDriverPersonFieldLabel("driver_leave"), "Driver (DR) on leave");
  assert.equal(adhocDriverPersonFieldLabel("dcd_leave"), "DCD / ODCD on leave");
  assert.equal(adhocDriverPersonFieldLabel(""), "Person on leave");
  assert.equal(
    adhocDriverDetails({ adhoc_driver: { reason_key: "driver_leave", work_date: "2026-11-08" } })?.reason_key,
    "driver_leave"
  );
  assert.equal(adhocDriverDetails({}), null);
});

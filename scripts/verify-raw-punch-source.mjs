import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/lib/biometric/raw-punch-report.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { rawPunchSourceDetails, resolveRawPunchDevice, buildRawPunchDeviceIndex } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

const portal = {
  device_serial: "ETIMEOFFICE", employee_code: "OLD1079", enrolment_id: null,
  payload: { source: "eTime Office portal", portal_machine: "1 - JDBD-Jagdalpur", portal_record_id: "42", possible_middleware_matches: [{ raw_event_id: "existing" }] }
};
const detail = rawPunchSourceDetails(portal);
assert.equal(detail.label, "Team Office");
assert.equal(detail.employeeCode, "OLD1079");
assert.equal(detail.recordId, "42");
assert.equal(detail.possibleOverlapCount, 1);
assert.match(detail.note, /minute precision/);
assert.match(detail.note, /unverified/);
assert.equal(resolveRawPunchDevice(portal, buildRawPunchDeviceIndex([{ id: "device", device_serial: "REAL", terminal_id: "1", device_no: "1", location_id: "JDBD" }])).device, undefined);
assert.equal(rawPunchSourceDetails({ device_serial: "REAL" }).label, "Device / middleware");
assert.equal(rawPunchSourceDetails({ device_serial: "ETIMEOFFICE", payload: null }).employeeCode, "");
assert.equal(rawPunchSourceDetails({ device_serial: "ETIMEOFFICE", payload: { portal_employee_code: "LEGACY" } }).employeeCode, "LEGACY");
const page = fs.readFileSync("src/app/reports/raw-punches/page.tsx", "utf8");
const route = fs.readFileSync("src/app/api/reports/raw-punches/export/route.ts", "utf8");
for (const text of [page, route]) {
  assert.match(text, /employee_code, payload/);
  assert.match(text, /employee_code\.ilike/);
  assert.match(text, /\.order\("id", \{ ascending: false \}\)/);
  assert.match(text, /rawPunchSourceDetails\(row\)/);
  assert.match(text, /authorization\.hasAllLocationAccess/);
}
assert.match(route, /"Source employee ID"/);
assert.match(route, /"Source machine \(unverified\)"/);
assert.match(route, /source\.isTeamOffice\s*\? "Raw only"/);
console.log("Raw punch source evidence and scope regression tests passed.");

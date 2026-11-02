import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dir = path.dirname(fileURLToPath(import.meta.url));
function load(relative) {
  const source = fs.readFileSync(path.join(dir, relative), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: relative
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("exports", "module", "require", outputText)(module.exports, module, (id) => {
    if (id === "./approval-designation-labels") return load("approval-designation-labels.ts");
    throw new Error(`Unexpected import ${id}`);
  });
  return module.exports;
}

const {
  classifyResignationTier,
  planResignationSeats,
  resolveResignationSeats
} = load("exit-resignation-route.ts");

test("Cluster Manager resignations stop at Head Operations, not National Head", () => {
  const tier = classifyResignationTier({ code: "CLM", name: "Cluster Manager" });
  assert.equal(tier, "mid");
  const seats = planResignationSeats(tier);
  const { resolved } = resolveResignationSeats({
    seats,
    chain: [
      {
        userId: "inayath",
        name: "INAYATH SHAIK",
        positionTitle: "Head Operations- Last Mile",
        designation: { code: "HLM", name: "Head Operations- Last Mile" }
      },
      {
        userId: "abdul",
        name: "ABDUL GAFOOR",
        positionTitle: "National Head",
        designation: { code: "NH", name: "National Head" }
      }
    ]
  });
  const managerSeat = resolved.find((row) => row.status === "resolved" && row.approverSource === "reporting_manager");
  assert.equal(managerSeat?.assignedUserId, "inayath");
});

test("National Head still matches when no Head Operations sits above the requester", () => {
  const seats = planResignationSeats("mid");
  const { resolved } = resolveResignationSeats({
    seats,
    chain: [
      {
        userId: "abdul",
        name: "ABDUL GAFOOR",
        designation: { code: "NH", name: "National Head" }
      }
    ]
  });
  const managerSeat = resolved.find((row) => row.status === "resolved" && row.approverSource === "reporting_manager");
  assert.equal(managerSeat?.assignedUserId, "abdul");
});

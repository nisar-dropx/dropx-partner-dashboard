import assert from "node:assert/strict";
import test from "node:test";
import {
  isWriteLikeToolName,
  listMcpTools,
  listMcpToolsForAuth
} from "./tools-policy.ts";

test("tool catalog is read-only and covers Fleet menus", () => {
  const tools = listMcpTools();
  assert.ok(tools.length >= 7);
  for (const tool of tools) {
    assert.equal(isWriteLikeToolName(tool.name), false);
    assert.ok(tool.inputSchema);
    assert.ok(tool.pageCodes.length >= 1);
  }
});

test("write-like tool names are rejected by policy", () => {
  assert.equal(isWriteLikeToolName("fleet_vehicle_write"), true);
  assert.equal(isWriteLikeToolName("create_payment_proof"), true);
  assert.equal(isWriteLikeToolName("fleet_availability_snapshot"), false);
});

test("listMcpToolsForAuth filters by page permission", () => {
  const none = listMcpToolsForAuth(() => false);
  assert.deepEqual(none, []);

  const actionCenterOnly = listMcpToolsForAuth((code) => code === "fleet_action_center");
  assert.ok(actionCenterOnly.every((tool) => tool.pageCodes.includes("fleet_action_center")));
  assert.ok(actionCenterOnly.some((tool) => tool.name === "fleet_attention_summary"));
  assert.equal(
    actionCenterOnly.some((tool) => tool.name === "fleet_audit_risk_summary"),
    false
  );

  const withAudits = listMcpToolsForAuth(
    (code) => code === "fleet_action_center" || code === "fleet_audits"
  );
  assert.ok(withAudits.some((tool) => tool.name === "fleet_audit_risk_summary"));
});

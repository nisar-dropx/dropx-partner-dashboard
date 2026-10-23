import assert from "node:assert/strict";
import test from "node:test";
import {
  isWriteLikeToolName,
  listMcpTools,
  listMcpToolsForAuth
} from "./tools-policy.ts";

test("tool catalog is read-only and covers Ops menus", () => {
  const tools = listMcpTools();
  assert.ok(tools.length >= 20);
  for (const tool of tools) {
    assert.equal(isWriteLikeToolName(tool.name), false);
    assert.ok(tool.inputSchema);
    assert.ok(tool.pageCodes.length >= 1);
  }
});

test("write-like tool names are rejected by policy", () => {
  assert.equal(isWriteLikeToolName("ops_loss_write"), true);
  assert.equal(isWriteLikeToolName("create_cod_submission"), true);
  assert.equal(isWriteLikeToolName("ops_capacity_snapshot"), false);
});

test("listMcpToolsForAuth filters by page permission", () => {
  const none = listMcpToolsForAuth(() => false);
  assert.deepEqual(none, []);

  const pulseOnly = listMcpToolsForAuth((code) => code === "ops_pulse");
  assert.ok(pulseOnly.every((tool) => tool.pageCodes.includes("ops_pulse")));
  assert.ok(pulseOnly.some((tool) => tool.name === "ops_command_center"));
  assert.equal(
    pulseOnly.some((tool) => tool.name === "ops_capacity_snapshot"),
    false
  );

  const withCapacity = listMcpToolsForAuth(
    (code) => code === "ops_pulse" || code === "capacity"
  );
  assert.ok(withCapacity.some((tool) => tool.name === "ops_capacity_snapshot"));
});

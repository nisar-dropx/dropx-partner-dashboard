import assert from "node:assert/strict";
import test from "node:test";
import { isWriteLikeToolName, listMcpTools } from "./tools-policy.ts";

test("tool catalog is read-only and non-empty", () => {
  const tools = listMcpTools();
  assert.ok(tools.length >= 4);
  for (const tool of tools) {
    assert.equal(isWriteLikeToolName(tool.name), false);
    assert.ok(tool.inputSchema);
  }
});

test("write-like tool names are rejected by policy", () => {
  assert.equal(isWriteLikeToolName("ops_loss_write"), true);
  assert.equal(isWriteLikeToolName("create_cod_submission"), true);
  assert.equal(isWriteLikeToolName("ops_capacity_snapshot"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { handleMcpJsonRpcCore } from "./protocol-core.ts";

test("initialize returns server capabilities", async () => {
  const response = await handleMcpJsonRpcCore({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {}
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.serverInfo.name, "dropx-fleet-mcp");
  assert.ok(response.result.capabilities.tools);
});

test("tools/list returns read-only tools", async () => {
  const response = await handleMcpJsonRpcCore({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  });
  assert.equal(response.error, undefined);
  assert.ok(response.result.tools.some((tool) => tool.name === "fleet_availability_snapshot"));
  assert.ok(response.result.tools.some((tool) => tool.name === "fleet_attention_summary"));
  assert.ok(response.result.tools.length >= 7);
});

test("tools/list can be filtered by auth hook", async () => {
  const { listMcpToolsForAuth } = await import("./tools-policy.ts");
  const response = await handleMcpJsonRpcCore(
    { jsonrpc: "2.0", id: 6, method: "tools/list" },
    {
      listTools: () =>
        listMcpToolsForAuth((code) => code === "fleet_action_center" || code === "fleet_audits")
    }
  );
  assert.equal(response.error, undefined);
  const names = response.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("fleet_audit_risk_summary"));
  assert.ok(names.includes("fleet_availability_snapshot"));
  assert.equal(names.includes("fleet_mapping_mail_summary"), false);
});

test("write methods and write-like tools are rejected", async () => {
  const writeMethod = await handleMcpJsonRpcCore({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/write"
  });
  assert.equal(writeMethod.error.code, -32601);

  const writeTool = await handleMcpJsonRpcCore({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "fleet_payment_approve", arguments: {} }
  });
  assert.equal(writeTool.error.code, -32601);

  const unknown = await handleMcpJsonRpcCore({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "not_a_real_tool", arguments: {} }
  });
  assert.equal(unknown.error.code, -32601);
});

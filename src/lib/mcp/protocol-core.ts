import {
  assertReadOnlyToolName,
  listMcpTools,
  toolToListEntry,
  type McpToolDefinition
} from "./tools-policy.ts";

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const SERVER_INFO = {
  name: "dropx-ops-mcp",
  version: "1.0.0"
};

const PROTOCOL_VERSION = "2024-11-05";

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export type McpJsonRpcHooks = {
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  listTools?: () => McpToolDefinition[] | Promise<McpToolDefinition[]>;
};

/**
 * Protocol routing without DB. Hooks inject auth-aware list/call.
 */
export async function handleMcpJsonRpcCore(
  body: JsonRpcRequest,
  hooks: McpJsonRpcHooks = {}
): Promise<JsonRpcResponse> {
  const id = body.id ?? null;
  if (body.jsonrpc && body.jsonrpc !== "2.0") {
    return jsonRpcError(id, -32600, "Invalid Request: jsonrpc must be 2.0");
  }
  const method = String(body.method ?? "").trim();
  if (!method) return jsonRpcError(id, -32600, "Invalid Request: method required");

  try {
    if (method === "initialize") {
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      });
    }
    if (method === "notifications/initialized" || method === "ping") {
      return jsonRpcResult(id, {});
    }
    if (method === "tools/list") {
      const tools = await (hooks.listTools ?? (() => listMcpTools()))();
      return jsonRpcResult(id, {
        tools: tools.map(toolToListEntry)
      });
    }
    if (method === "tools/call") {
      const params = body.params ?? {};
      const name = String(params.name ?? "").trim();
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      if (!name) return jsonRpcError(id, -32602, "Invalid params: name required");
      assertReadOnlyToolName(name);
      if (!hooks.callTool) {
        return jsonRpcError(id, -32000, "Tool runner unavailable");
      }
      const result = await hooks.callTool(name, args);
      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false
      });
    }
    if (method.startsWith("resources/") || method.startsWith("prompts/")) {
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
    if (/write|create|update|delete|mutate/i.test(method)) {
      return jsonRpcError(id, -32601, `Unsupported write method: ${method}`);
    }
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    const err = error as { code?: number; message?: string };
    return jsonRpcError(id, typeof err.code === "number" ? err.code : -32000, err.message || "Internal error");
  }
}

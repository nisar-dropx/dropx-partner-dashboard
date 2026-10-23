import type { AuthorizationContext } from "@/lib/authorization";
import { callMcpTool, mcpToolsVisibleTo } from "@/lib/mcp/tools";
import {
  handleMcpJsonRpcCore,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "@/lib/mcp/protocol-core";

export type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "@/lib/mcp/protocol-core";
export { jsonRpcError, jsonRpcResult } from "@/lib/mcp/protocol-core";

export async function handleMcpJsonRpc(
  authorization: AuthorizationContext,
  body: JsonRpcRequest | JsonRpcRequest[]
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  const hooks = {
    listTools: () => mcpToolsVisibleTo(authorization),
    callTool: (name: string, args: Record<string, unknown>) => callMcpTool(authorization, name, args)
  };
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      responses.push(await handleMcpJsonRpcCore(item, hooks));
    }
    return responses;
  }
  return handleMcpJsonRpcCore(body, hooks);
}

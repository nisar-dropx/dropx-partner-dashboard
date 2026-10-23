import type { AuthorizationContext } from "@/lib/authorization";
import { callMcpTool } from "@/lib/mcp/tools";
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
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      responses.push(
        await handleMcpJsonRpcCore(item, (name, args) => callMcpTool(authorization, name, args))
      );
    }
    return responses;
  }
  return handleMcpJsonRpcCore(body, (name, args) => callMcpTool(authorization, name, args));
}

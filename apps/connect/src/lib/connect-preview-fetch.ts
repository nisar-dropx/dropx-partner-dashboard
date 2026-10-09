import { cookies } from "next/headers";
import { connectPreviewCookieName, previewReadOnlyMessage } from "./connect-preview-policy";
export function previewSafeFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    let preview = false;
    try { preview = Boolean(cookies().get(connectPreviewCookieName)?.value); } catch { /* Build/non-request context */ }
    if (preview) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      // Signed download URLs are read access; the regularization rules RPC only reads master data.
      const sessionRevoke = method === "PATCH" && url.pathname === "/rest/v1/connect_login_sessions";
      const readOperation = sessionRevoke || ["GET", "HEAD", "OPTIONS"].includes(method) ||
        (method === "POST" && (url.pathname.startsWith("/storage/v1/object/sign/") || url.pathname === "/rest/v1/rpc/hr_regularization_rules"));
      if (!readOperation) return new Response(JSON.stringify({ message: previewReadOnlyMessage, code: "read_only_preview" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    return fetcher(input, init);
  };
}

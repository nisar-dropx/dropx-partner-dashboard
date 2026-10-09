// A single Supabase REST/Auth call should never legitimately take this long.
// This only ever catches a genuinely stuck connection (a Supabase-side outage
// or Cloudflare edge timeout), not a normal slow query - it exists so a hung
// dependency fails fast on its own terms instead of hanging the whole
// request/serverless invocation until the platform kills it.
const SUPABASE_FETCH_TIMEOUT_MS = 20_000;

export const DATABASE_UNREACHABLE_MESSAGE = "The database is not reachable right now. Please check your connection and try again in a moment.";

// Supabase always answers in JSON. An HTML error body is a Cloudflare/gateway
// outage page, and a thrown fetch is a dropped or timed-out connection. Both
// are replaced with a JSON error so callers surface one readable message
// instead of raw HTML markup or "TypeError: fetch failed".
function unreachableResponse(status = 503) {
  return new Response(JSON.stringify({
    code: "DATABASE_UNREACHABLE",
    message: DATABASE_UNREACHABLE_MESSAGE,
    msg: DATABASE_UNREACHABLE_MESSAGE,
    error: DATABASE_UNREACHABLE_MESSAGE
  }), { status, headers: { "content-type": "application/json" } });
}

/**
 * Wraps `fetch` with a hard deadline so a stalled Supabase/Cloudflare
 * connection can't hang an entire request. Composes with any signal the
 * caller already passed rather than replacing it.
 */
export function timeoutFetch(fetcher: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUPABASE_FETCH_TIMEOUT_MS);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    callerSignal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const response = await fetcher(input, { ...init, signal: controller.signal });
      if (!response.ok && (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
        return unreachableResponse(response.status >= 500 ? response.status : 503);
      }
      return response;
    } catch (error) {
      // A caller that cancelled its own request still expects the abort.
      if (callerSignal?.aborted) throw error;
      return unreachableResponse();
    } finally {
      clearTimeout(timer);
    }
  };
}

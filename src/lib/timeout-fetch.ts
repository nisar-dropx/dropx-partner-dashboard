// A single Supabase REST/Auth call should never legitimately take this long.
// This only ever catches a genuinely stuck connection (a Supabase-side outage
// or Cloudflare edge timeout), not a normal slow query - it exists so a hung
// dependency fails fast on its own terms instead of hanging the whole
// request/serverless invocation until the platform kills it.
const SUPABASE_FETCH_TIMEOUT_MS = 20_000;

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
      return await fetcher(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

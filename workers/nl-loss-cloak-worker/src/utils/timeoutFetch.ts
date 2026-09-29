/** Bound Supabase requests and body reads; preserve caller cancellation. */
const SUPABASE_FETCH_TIMEOUT_MS = 20_000;

export function timeoutFetch(fetcher: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  return (input, init) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeout = AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS);
    // Some spreadsheet dependencies declare an older AbortSignal type. Workers
    // supports any(); keep this local annotation instead of changing global DOM types.
    const signals = AbortSignal as unknown as { any(values: AbortSignal[]): AbortSignal };
    const signal = callerSignal ? signals.any([callerSignal, timeout]) : timeout;
    return fetcher(input, { ...init, signal });
  };
}

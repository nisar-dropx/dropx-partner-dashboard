import { useCallback, useEffect, useRef } from "react";

/**
 * Companion to the app shell's keep-alive tabs (connect-login-flow.tsx keeps
 * every visited screen mounted and only toggles CSS `hidden` when switching,
 * so re-opening a tab is instant instead of re-fetching from scratch). That
 * means a screen's own data-loading effect only runs once, on first mount -
 * without this hook, data would go stale forever for the rest of the
 * session once a screen has been visited.
 *
 * Usage: call this before defining your `load` callback (so `markLoaded` is
 * available to close over), call `markLoaded()` once your fetch succeeds,
 * and pass `load` back in via the returned `setReload` inside the same
 * render (a plain assignment, not a dependency-array entry, so it carries
 * no ordering requirement either way):
 *
 *   const { markLoaded, setReload } = useKeepAliveRefresh(active);
 *   const load = useCallback(async () => { ...; markLoaded(); }, [...]);
 *   setReload(load);
 *   useEffect(() => { void load(); }, [load]);
 *
 * `reload` fires the moment the screen becomes active again (`active` flips
 * from false to true), but only if at least `staleMs` has passed since the
 * last `markLoaded()` call - so rapid tab-switching doesn't refetch on
 * every switch, only when the data has genuinely had time to go stale.
 */
export function useKeepAliveRefresh(active: boolean, staleMs = 120_000) {
  const lastLoadedAt = useRef(0);
  const wasActive = useRef(active);
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!wasActive.current && active) {
      const now = Date.now();
      if (now - lastLoadedAt.current > staleMs) {
        lastLoadedAt.current = now;
        reloadRef.current();
      }
    }
    wasActive.current = active;
  }, [active, staleMs]);

  return {
    /** Call this from the screen's own fetch effect once data lands, so the staleness clock starts from a real load. Stable across renders. */
    markLoaded: useCallback(() => { lastLoadedAt.current = Date.now(); }, []),
    /** Register (or re-register) the function to call when the screen becomes active again after going stale. Plain assignment - safe to call on every render. */
    setReload: (reload: () => void) => { reloadRef.current = reload; }
  };
}

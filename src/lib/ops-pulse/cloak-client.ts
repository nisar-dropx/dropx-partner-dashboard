import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseLiveWindow } from "./nl-dispute-policy";

// Fixed origin: callers pass an API path, never a URL.
const CLOAK_ORIGIN = "https://cloak.tech.amazon.dev";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export class CloakError extends Error {
  constructor(
    message: string,
    readonly code: "NO_SESSION" | "SESSION_EXPIRED" | "NETWORK" | "HTTP",
  ) {
    super(message);
  }
}

/** The cookie nl-loss-cloak-worker keeps fresh (it renews the session before every hourly pull). */
export async function cloakCookie(accountKey = "default") {
  const { data } = await supabaseAdmin!
    .from("cloak_sessions")
    .select("cookie")
    .eq("status", "active")
    .eq("account_key", accountKey)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.cookie as string | undefined) || null;
}

/** GET a Cloak JSON API with the stored session. Cloak allows this network (Vercel), not the worker's. */
export async function cloakGet<T>(
  path: `/api/v1/${string}`,
  params: Record<string, string>,
  cookie?: string | null,
): Promise<T> {
  const session = cookie ?? (await cloakCookie());
  if (!session) throw new CloakError("Cloak is not connected.", "NO_SESSION");
  let res: Response;
  try {
    res = await fetch(`${CLOAK_ORIGIN}${path}?${new URLSearchParams(params)}`, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: {
        accept: "application/json, text/plain, */*",
        cookie: session,
        referer: `${CLOAK_ORIGIN}/`,
        "user-agent": USER_AGENT,
      },
    });
  } catch {
    throw new CloakError("Cloak could not be reached.", "NETWORK");
  }
  const html = (res.headers.get("content-type") ?? "").includes("text/html");
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400) || html)
    throw new CloakError(
      "The Cloak session is being renewed. Try again in a few minutes.",
      "SESSION_EXPIRED",
    );
  if (!res.ok) throw new CloakError(`Cloak returned ${res.status}.`, "HTTP");
  try {
    return (await res.json()) as T;
  } catch {
    throw new CloakError("Cloak returned an unreadable response.", "HTTP");
  }
}

/**
 * Stores the live month's SLA deadlines. Cloak only exposes them on the case list
 * (not in the bulk export), so one page-1 read rides along with the hourly pull.
 * Best effort: a failure keeps the previous deadlines.
 */
export async function refreshLiveWindow(
  accountKey: string,
  cookie: string,
  query: { country: string; partner_shortcode: string; case_with: string },
) {
  try {
    const page = await cloakGet<{ data?: { slaDeadlines?: unknown }[] }>(
      "/api/v1/getTIDData",
      { page: "1", ...query, dataSource: "live" },
      cookie,
    );
    const deadlines = page.data?.find((row) => Array.isArray(row?.slaDeadlines))?.slaDeadlines;
    const window = parseLiveWindow(deadlines);
    if (!Object.keys(window).length) return;
    const current = await supabaseAdmin!
      .from("nl_loss_sources")
      .select("live_window")
      .eq("account_key", accountKey)
      .maybeSingle();
    // Deadlines change once a month; an unchanged read must not add Master history.
    const same = (a: unknown) =>
      JSON.stringify(Object.entries(a ?? {}).sort()) ===
      JSON.stringify(Object.entries(window).sort());
    if (current.error || same(current.data?.live_window)) return;
    await supabaseAdmin!
      .from("nl_loss_sources")
      .update({ live_window: window, live_window_checked_at: new Date().toISOString() })
      .eq("account_key", accountKey);
  } catch {
    /* previous deadlines stay in place */
  }
}

import { TimeoutError, withTimeout } from "./with-timeout";

type SessionUser = { id: string; email?: string | null };
type AuthClient = {
  getUser: () => Promise<{ data: { user: SessionUser | null }; error?: unknown }>;
  getClaims?: () => Promise<{ data?: { claims?: Record<string, unknown> | null } | null; error?: unknown }>;
};
export type SessionVerification =
  | { status: "verified"; user: SessionUser }
  | { status: "missing" | "unavailable"; user: null };

function isTransient(error: unknown) {
  if (error instanceof TimeoutError) return true;
  const candidate = error as { name?: unknown; message?: unknown; status?: unknown } | null;
  const name = String(candidate?.name ?? "").toLowerCase();
  const message = String(candidate?.message ?? "").toLowerCase();
  return name === "aborterror" || name === "authretryablefetcherror" ||
    Number(candidate?.status ?? 0) >= 500 || /abort|timeout|network|fetch failed/.test(message);
}

/** Keep one user check in flight. A promise timeout does not cancel Supabase's
 * fetch or token refresh; queuing another check used to discard late success.
 * Only a completed transient failure is retried. Claims must be SDK-verified,
 * and a definitive rejection always wins over a concurrent claims result. */
export async function verifySession(
  auth: AuthClient,
  timing = { initialMs: 5000, claimsMs: 3000, totalMs: 25000 }
): Promise<SessionVerification> {
  const deadline = Date.now() + timing.totalMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let completed: SessionVerification | undefined;
  const checkUser = () => {
    completed = undefined;
    return Promise.resolve().then(() => auth.getUser()).then((result): SessionVerification => {
      if (result.data.user) return { status: "verified", user: result.data.user };
      return { status: isTransient(result.error) ? "unavailable" : "missing", user: null };
    }, (error): SessionVerification => ({ status: isTransient(error) ? "unavailable" : "missing", user: null }))
      .then((result) => { completed = result; return result; });
  };
  let pending = checkUser();
  try {
    const result = await withTimeout(pending, Math.min(timing.initialMs, remaining()), "Session check");
    if (result.status !== "unavailable") return result;
  } catch { /* Still pending: retain the original promise. */ }

  if (auth.getClaims) {
    try {
      const result = await withTimeout(auth.getClaims(), Math.min(timing.claimsMs, remaining()), "Session claims");
      if (completed && completed.status !== "unavailable") return completed;
      const claims = result.error ? null : result.data?.claims;
      if (typeof claims?.sub === "string" && claims.sub) {
        return { status: "verified", user: { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null } };
      }
    } catch { /* Claims cannot be used until verified. */ }
  }

  // Allow the original request to finish inside the overall deadline. Its
  // network timeout is 20s, so the 25s budget leaves room for one real retry.
  try {
    let result = completed ?? await withTimeout(pending, remaining(), "Session check completion");
    if (result.status !== "unavailable") return result;
    if (Date.now() >= deadline) return result;
    pending = checkUser();
    result = await withTimeout(pending, remaining(), "Session check retry");
    return result;
  } catch {
    return { status: "unavailable", user: null };
  }
}

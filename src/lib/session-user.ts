import { cache } from "react";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { TimeoutError, withTimeout } from "@/lib/with-timeout";

const AUTH_TIMEOUT_MS = 5000;
const AUTH_CLAIMS_TIMEOUT_MS = 3000;

export type AuthenticatedUser = {
  id: string;
  email: string | null | undefined;
};

export const sessionProfileColumns = "id, email, full_name, role_id, location_scope_ids, is_active, company_id, is_master_owner";
export const legacySessionProfileColumns = "id, email, full_name, role_id, location_scope_ids, is_active";

function isTransientAuthFailure(error: unknown) {
  if (error instanceof TimeoutError) return true;
  const candidate = error as { name?: unknown; message?: unknown; status?: unknown } | null;
  const name = String(candidate?.name ?? "").toLowerCase();
  const message = String(candidate?.message ?? "").toLowerCase();
  const status = Number(candidate?.status ?? 0);
  return name === "aborterror" ||
    status >= 500 ||
    message.includes("abort") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch failed");
}

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

async function getVerifiedClaimsUser(supabase: NonNullable<ReturnType<typeof createServerSupabaseClient>>): Promise<AuthenticatedUser | null> {
  const getClaims = (supabase.auth as {
    getClaims?: () => Promise<{ data?: { claims?: Record<string, unknown> | null } | null }>;
  }).getClaims;
  if (typeof getClaims !== "function") return null;

  try {
    const result = await withTimeout(getClaims.call(supabase.auth), AUTH_CLAIMS_TIMEOUT_MS, "Session claim check");
    const claims = result.data?.claims;
    const id = typeof claims?.sub === "string" ? claims.sub : "";
    if (!id) return null;
    return {
      id,
      email: typeof claims?.email === "string" ? claims.email : null
    };
  } catch {
    return null;
  }
}

/**
 * The signed access token is verified locally first, so a normal request never
 * touches the Auth API (and the database behind it). The Auth API is asked only
 * when the token cannot be verified locally.
 *
 * A single slow-but-alive Supabase response (common under sustained DB load)
 * should never be indistinguishable from "you're not signed in." Before a
 * timeout can reach the normal sign-in path, verify the locally held JWT
 * claims. That preserves a valid signed session during a transient Auth API
 * delay while still rejecting missing, expired, or invalid sessions.
 */
async function getUserWithRetry(supabase: ReturnType<typeof createServerSupabaseClient>): Promise<AuthenticatedUser | null> {
  if (!supabase) return null;
  const locallyVerifiedUser = await getVerifiedClaimsUser(supabase);
  if (locallyVerifiedUser) return locallyVerifiedUser;

  try {
    const result = await withTimeout(supabase.auth.getUser(), AUTH_TIMEOUT_MS, "Sign-in check");
    if (result.data.user) {
      return { id: result.data.user.id, email: result.data.user.email };
    }
    if (!isTransientAuthFailure(result.error)) return null;
  } catch (error) {
    if (!isTransientAuthFailure(error)) return null;
  }

  const verifiedClaimsUser = await getVerifiedClaimsUser(supabase);
  if (verifiedClaimsUser) return verifiedClaimsUser;

  try {
    const retry = await withTimeout(supabase.auth.getUser(), AUTH_TIMEOUT_MS, "Sign-in check (retry)");
    return retry.data.user
      ? { id: retry.data.user.id, email: retry.data.user.email }
      : null;
  } catch {
    return null;
  }
}

// One session check per request, shared by authorization and user preview.
export const getSessionUser = cache(async (): Promise<AuthenticatedUser | null> => {
  return getUserWithRetry(createServerSupabaseClient());
});

// One profile read per request. Deliberately not cached across requests:
// deactivating a user must take effect on their very next request.
export const loadSessionProfile = cache(async (userId: string) => {
  let { data, error } = await supabaseAdmin!
    .from("profiles")
    .select(sessionProfileColumns)
    .eq("id", userId)
    .maybeSingle();

  if (error && isMissingColumnError(error)) {
    const legacyResult = await supabaseAdmin!
      .from("profiles")
      .select(legacySessionProfileColumns)
      .eq("id", userId)
      .maybeSingle();
    data = legacyResult.data as typeof data;
    error = legacyResult.error;
  }

  return { data, error };
});

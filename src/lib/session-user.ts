import { cache } from "react";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { withTimeout } from "@/lib/with-timeout";

import { isTransientAuthFailure, SessionUnavailableError } from "@/lib/auth-session-policy";

const AUTH_TIMEOUT_MS = 5000;
const AUTH_CLAIMS_TIMEOUT_MS = 3000;

export type AuthenticatedUser = {
  id: string;
  email: string | null | undefined;
};

export const sessionProfileColumns = "id, email, full_name, role_id, location_scope_ids, is_active, company_id, is_master_owner";
export const legacySessionProfileColumns = "id, email, full_name, role_id, location_scope_ids, is_active";

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

/** Do not turn an unavailable identity service into an invalid session, or
 * start a second refresh while a timed-out refresh is still in flight. */
async function getUserWithRetry(supabase: ReturnType<typeof createServerSupabaseClient>): Promise<AuthenticatedUser | null> {
  if (!supabase) throw new SessionUnavailableError();
  try {
    if (typeof supabase.auth.getClaims === "function") {
      const result = await withTimeout(supabase.auth.getClaims(), AUTH_CLAIMS_TIMEOUT_MS, "Session claim check");
      if (result.error && isTransientAuthFailure(result.error)) throw new SessionUnavailableError();
      const claims = result.data?.claims;
      if (typeof claims?.sub === "string") {
        return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
      }
      if (result.error) return null;
    }
    const result = await withTimeout(supabase.auth.getUser(), AUTH_TIMEOUT_MS, "Sign-in check");
    if (result.error && isTransientAuthFailure(result.error)) throw new SessionUnavailableError();
    return result.data.user ? { id: result.data.user.id, email: result.data.user.email } : null;
  } catch (error) {
    if (error instanceof SessionUnavailableError || isTransientAuthFailure(error)) throw new SessionUnavailableError();
    throw error;
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

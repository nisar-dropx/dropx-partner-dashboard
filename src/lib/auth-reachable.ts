import { DATABASE_UNREACHABLE_MESSAGE } from "./timeout-fetch";

const AUTH_PROBE_TIMEOUT_MS = 8_000;

/**
 * Google sign-in sends the browser itself to the Supabase Auth host, so an
 * outage there shows the visitor a raw gateway error page that no code of ours
 * can replace. Checking the Auth host first lets the login page show a
 * readable message instead. Returns the message to show, or null when Auth is up.
 */
export async function authUnreachableMessage() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !apiKey) return null;
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/health`, {
      cache: "no-store",
      headers: { apikey: apiKey },
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS)
    });
    return response.status >= 500 ? DATABASE_UNREACHABLE_MESSAGE : null;
  } catch {
    return DATABASE_UNREACHABLE_MESSAGE;
  }
}

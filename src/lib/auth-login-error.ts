const PKCE_VERIFIER_MISSING =
  "Google sign-in could not finish in this browser. Open the same site again in Chrome or Safari (not WhatsApp, Instagram, or another in-app browser), then tap Sign in with Google again.";

/**
 * Map raw Supabase Auth errors to instructions operators can follow.
 * PKCE "code verifier not found" almost always means the OAuth round-trip
 * started in one browser/webview and returned in another (or storage was cleared).
 */
export function friendlyAuthLoginError(message: string | null | undefined) {
  const text = String(message ?? "").trim();
  if (!text) return text;
  if (/pkce|code verifier not found/i.test(text)) return PKCE_VERIFIER_MISSING;
  return text;
}

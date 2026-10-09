/** A single rotating Supabase session is shared by the existing DropX portals. */
export const LEGACY_OPS_AUTH_KEY = "dropx-ops-auth-v3";

export function sharedAuthStorageKey(supabaseUrl: string) {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

export class SessionUnavailableError extends Error {
  constructor() {
    super("Your session could not be checked right now. Please retry; you have not been signed out.");
    this.name = "SessionUnavailableError";
  }
}

export function isTransientAuthFailure(error: unknown) {
  const candidate = error as { name?: unknown; message?: unknown; status?: unknown; code?: unknown } | null;
  const name = String(candidate?.name ?? "").toLowerCase();
  const message = String(candidate?.message ?? "").toLowerCase();
  const status = Number(candidate?.status ?? 0);
  return name === "timeouterror" || name === "aborterror" ||
    name === "authretryablefetcherror" || status >= 500 || status === 429 ||
    message.includes("abort") || message.includes("timeout") ||
    message.includes("network") || message.includes("fetch failed");
}

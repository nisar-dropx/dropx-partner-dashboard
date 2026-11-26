/**
 * Report Bot rejects client_ref unless /^[A-Za-z0-9_-]{8,64}$/.
 * Dedupe keys contain ":" / ISO times / spaces — hash them.
 */
export async function clientRefForAlert(dedupeKey) {
  const bytes = new TextEncoder().encode(String(dedupeKey ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `datoms_${hex.slice(0, 48)}`;
}

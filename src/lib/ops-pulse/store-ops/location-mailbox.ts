/** Shared station mailboxes (tta5@…, tcc3@…) — not assigned Store Manager / SIC people. */
export function isLocationMailboxRole(
  roleCode?: string | null,
  roleCodes?: Iterable<string> | null,
) {
  const codes = [
    ...(roleCodes || []),
    ...(roleCode ? [roleCode] : []),
  ].map((c) => String(c || "").trim().toUpperCase());
  return codes.some((c) => c === "OPERATIONS_LOCATION" || c === "LOCATION");
}

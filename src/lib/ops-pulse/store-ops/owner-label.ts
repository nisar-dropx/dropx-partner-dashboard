/**
 * Shared store logins often set profiles.full_name to the station code (TCC3…).
 * That value is denormalized onto checklists as owner_name and then appears in
 * "By person". Relabel those so the person table stays people-first.
 */
export function resolveStoreOwnerLabel(
  ownerName: string | null | undefined,
  storeCodes: Iterable<string>,
) {
  const raw = (ownerName || "").trim() || "—";
  if (raw === "—") return raw;
  const codes = new Set(
    [...storeCodes].map((c) => c.trim().toUpperCase()).filter(Boolean),
  );
  if (codes.has(raw.toUpperCase())) return `Store login · ${raw}`;
  return raw;
}

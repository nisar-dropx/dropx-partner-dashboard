export type AuditEmployee = {
  ref: string;
  employee_code: string;
  full_name: string;
  designation: string;
  is_active: boolean;
};
export type ShipmentLists = {
  expected: string[];
  scanned: string[];
  remarks: Record<string, string>;
};
/** Only a TID column is accepted, so report headers or other cells cannot silently become shipments. */
export function parseAuditTids(raw: string) {
  if (raw.length > 1500000)
    throw new Error("TID list is too large. Maximum 10,000 unique TIDs.");
  const tokens = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const invalid = tokens.find(
    (t) => !/^(?=.*\d)[A-Z0-9][A-Z0-9_-]{3,79}$/.test(t),
  );
  if (invalid)
    throw new Error(
      `Invalid TID “${invalid.slice(0, 80)}”. Paste only the tracking-ID column, without its header.`,
    );
  const ids = [...new Set(tokens)];
  if (ids.length > 10000)
    throw new Error("Maximum 10,000 unique TIDs per list.");
  return { ids, duplicates: tokens.length - ids.length };
}
export function compareAuditTids(expected: string[], scanned: string[]) {
  const a = new Set(expected),
    b = new Set(scanned);
  return {
    missing: [...a].filter((t) => !b.has(t)),
    excess: [...b].filter((t) => !a.has(t)),
    matched: [...a].filter((t) => b.has(t)).length,
  };
}
export function selectedAuditEmployees(
  refs: string[],
  people: AuditEmployee[],
) {
  const unique = [...new Set(refs.filter(Boolean))];
  if (unique.length > 25) throw new Error("Select up to 25 employees.");
  return unique.map((ref) => {
    const person = people.find((p) => p.ref === ref);
    if (!person)
      throw new Error(
        "Selected employee is no longer linked to this station. Refresh and select again.",
      );
    return person;
  });
}

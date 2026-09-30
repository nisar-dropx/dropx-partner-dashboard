export type LocationPortalAccessDraft = Record<string, string[]>;

export function normalizePortalCodes(codes: readonly string[]) {
  return [...new Set(codes.map((code) => code.trim().toLowerCase()).filter(Boolean))].sort();
}

export function portalAccessChanged(before: readonly string[], after: readonly string[]) {
  const normalizedBefore = normalizePortalCodes(before);
  const normalizedAfter = normalizePortalCodes(after);
  return normalizedBefore.length !== normalizedAfter.length || normalizedBefore.some((code, index) => code !== normalizedAfter[index]);
}

export function applyBulkPortalAccess(
  draft: LocationPortalAccessDraft,
  locationIds: readonly string[],
  productCode: string,
  enabled: boolean
) {
  const normalizedProduct = productCode.trim().toLowerCase();
  const next = { ...draft };

  for (const locationId of locationIds) {
    const products = new Set(next[locationId] ?? []);
    if (enabled) products.add(normalizedProduct);
    else products.delete(normalizedProduct);
    next[locationId] = normalizePortalCodes([...products]);
  }

  return next;
}

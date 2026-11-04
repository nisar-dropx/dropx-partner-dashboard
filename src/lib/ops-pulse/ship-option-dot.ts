/**
 * Premium / Standard DOT classifiers from Amazon shipOption.
 * Must match amazon-edd-worker/src/services/shipOptionDot.ts.
 */

export type DotLane = "standard" | "premium" | null;

export function normalizeShipOption(value: unknown): string {
  return String(value ?? "").trim();
}

export function startsWithStd(shipOption: unknown): boolean {
  return normalizeShipOption(shipOption).toUpperCase().startsWith("STD");
}

export function includesSwa(shipOption: unknown): boolean {
  return normalizeShipOption(shipOption).toUpperCase().includes("SWA");
}

export function classifyShipOptionDot(shipOption: unknown): DotLane {
  const raw = normalizeShipOption(shipOption);
  if (!raw) return null;
  if (startsWithStd(raw)) return "standard";
  if (includesSwa(raw)) return null;
  return "premium";
}

export function isStandardDot(shipOption: unknown): boolean {
  return classifyShipOptionDot(shipOption) === "standard";
}

export function isPremiumDot(shipOption: unknown): boolean {
  return classifyShipOptionDot(shipOption) === "premium";
}

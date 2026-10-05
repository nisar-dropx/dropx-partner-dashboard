export type AssetTrackingMode = "individual" | "quantity";
export type AssetQuantityCondition = "good" | "damaged" | "unusable";

function parseWholeNumber(value: unknown, label: string, minimum: number) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a whole number.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be ${minimum === 0 ? "zero or more" : "at least one"}.`);
  }
  return parsed;
}

export function resolveAssetQuantities(input: {
  trackingMode?: unknown;
  total?: unknown;
  faulty?: unknown;
  individualCondition?: string;
}) {
  const trackingMode: AssetTrackingMode =
    String(input.trackingMode ?? "individual").trim().toLowerCase() === "quantity"
      ? "quantity"
      : "individual";

  if (trackingMode === "individual") {
    const faulty = ["damaged", "unusable"].includes(input.individualCondition ?? "") ? 1 : 0;
    return { trackingMode, total: 1, working: 1 - faulty, faulty };
  }

  const total = parseWholeNumber(input.total, "Total quantity", 1);
  const faulty = parseWholeNumber(input.faulty ?? 0, "Faulty / not working quantity", 0);
  if (faulty > total) throw new Error("Faulty / not working quantity cannot exceed total quantity.");

  return { trackingMode, total, working: total - faulty, faulty };
}

export function conditionForAssetQuantity(total: number, faulty: number): AssetQuantityCondition {
  if (faulty <= 0) return "good";
  return faulty >= total ? "unusable" : "damaged";
}

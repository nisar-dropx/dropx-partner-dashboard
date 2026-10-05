export type ShipmentEvidence = {
  trackingId: string; matched: boolean; pincode: string | null; weightKg: number | null;
  lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  volumetricKg: number | null; suitability: 'small' | 'bulky' | 'unknown'; snapshotAt: string | null;
};
export function positiveMeasurement(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
export function dimensionalWeight(length: unknown, width: unknown, height: unknown, cube: unknown, divisor: unknown) {
  const dimensions = [length, width, height].map(positiveMeasurement);
  const denominator = positiveMeasurement(divisor);
  const volume = dimensions.every(n => n != null) ? dimensions.reduce<number>((total, n) => total * n!, 1) : positiveMeasurement(cube);
  return volume && denominator ? volume / denominator : null;
}
export function shipmentPincodeBreakup(rows: ShipmentEvidence[]) {
  const counts = new Map<string, number>();
  for (const row of rows) { const pin = row.pincode || 'Pincode unavailable'; counts.set(pin, (counts.get(pin) ?? 0) + 1); }
  return [...counts].map(([pincode, count]) => ({ pincode, count })).sort((a, b) => b.count - a.count || a.pincode.localeCompare(b.pincode));
}

export function shipmentDestinationAllowed(destination: unknown, stations: string[], requireDestination: boolean) {
 const code = typeof destination === 'string' ? destination.trim().toUpperCase() : '';
 return code ? stations.includes(code) : !requireDestination;
}

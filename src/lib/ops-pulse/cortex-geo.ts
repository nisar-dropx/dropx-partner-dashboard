export function isValidGeo(
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean {
  return (
    lat != null &&
    lng != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asLatLng(
  latRaw: unknown,
  lngRaw: unknown,
): [number, number] | null {
  const lat = toFiniteNumber(latRaw);
  const lng = toFiniteNumber(lngRaw);
  if (!isValidGeo(lat, lng)) return null;
  return [lat!, lng!];
}

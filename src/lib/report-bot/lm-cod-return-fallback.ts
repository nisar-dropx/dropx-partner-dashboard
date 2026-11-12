/** Offline planning estimate, never evidence of arrival or a measured road route.
 * Direct distance × 1.8 at 15 km/h + 15 minutes allows for detours and stops.
 * Unusually distant/invalid coordinates remain unverified. No network or AI calls. */
export const DIRECT_ESTIMATE_BASIS = 'Direct-distance estimate';
export function directReturnEstimate(from: unknown, to: unknown) {
  const point = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && !(p[0] === 0 && p[1] === 0);
  if (!point(from) || !point(to)) return null;
  const rad = (n: number) => n * Math.PI / 180;
  const a = Math.sin(rad(to[0] - from[0]) / 2) ** 2 + Math.cos(rad(from[0])) * Math.cos(rad(to[0])) * Math.sin(rad(to[1] - from[1]) / 2) ** 2;
  const directKm = 6371 * 2 * Math.atan2(Math.sqrt(Math.max(0, Math.min(1, a))), Math.sqrt(Math.max(0, 1 - a)));
  if (directKm > 60) return null;
  return {distanceKm: Math.round(directKm * 10) / 10, travelMinutes: Math.ceil(directKm * 1.8 / 15 * 60) + 15, basis: DIRECT_ESTIMATE_BASIS};
}

export function approximateJourney(journey: {basis: string} | undefined) {
  return journey?.basis === DIRECT_ESTIMATE_BASIS;
}

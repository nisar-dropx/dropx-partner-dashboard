export type WheelseyeHistoryPoint = {
  longitude?: number | null;
  latitude?: number | null;
  speed?: number | null;
  dttimeInEpoch?: number;
  createdDateInEpoch?: number;
  ignition?: number | boolean;
  vehicleName?: string;
};
export type WheelseyeMovementSummary = {
  km: number;
  rawKm: number;
  maxSpeed: number;
  movingMinutes: number;
  pointCount: number;
  acceptedPointCount: number;
  rejectedPointCount: number;
  stationaryPointCount: number;
  lateNight: boolean;
  distanceReliable: boolean;
  rejectedSegments: number;
  quality: 'clean' | 'filtered' | 'needs_review';
  qualityReason: string;
  algorithmVersion: string;
};
type Point = { lat: number; lng: number; speed: number | null; epoch: number };
const MAX_SPEED = 160;
const POSITION_TOLERANCE_KM = 0.03;
const ALGORITHM = 'gps-moving-fixes-v2';
const plate = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const rounded = (value: number) => Math.round(value * 10) / 10;

export async function loadWheelseyeMovement(accessToken: string, vehicle: string, date: string) {
  const { fromTime, toTime } = dayEpochRange(date);
  const upstream = new URL('https://api.wheelseye.com/currentLocV2');
  upstream.searchParams.set('accessToken', accessToken);
  upstream.searchParams.set('searchText', vehicle);
  upstream.searchParams.set('fromTime', String(fromTime));
  upstream.searchParams.set('toTime', String(toTime));
  const response = await fetch(upstream, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) throw new Error('Unable to load WheelsEye movement.');
  if (!Array.isArray(payload?.Vehicle)) throw new Error('GPS provider returned an unexpected history response.');
  return calculateWheelseyeMovement(payload.Vehicle, vehicle, date);
}

/** GPS-derived movement, not an odometer reading. Never sum cached/stationary fixes into a moving track. */
export function calculateWheelseyeMovement(raw: WheelseyeHistoryPoint[], vehicle: string, date: string) {
  const { fromTime, toTime } = dayEpochRange(date);
  let rejectedPointCount = 0;
  const normalized: Point[] = [];
  for (const point of raw) {
    let epoch = Number(point.dttimeInEpoch || point.createdDateInEpoch || 0);
    if (epoch > 1e12) epoch = Math.floor(epoch / 1000);
    const lat = Number(point.latitude), lng = Number(point.longitude);
    if (point.latitude == null || point.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0) || !Number.isFinite(epoch) || epoch < fromTime || epoch > toTime || (point.vehicleName && plate(point.vehicleName) !== plate(vehicle))) {
      rejectedPointCount++; continue;
    }
    const speed = point.speed == null || !Number.isFinite(Number(point.speed)) || Number(point.speed) < 0 || Number(point.speed) > MAX_SPEED ? null : Number(point.speed);
    normalized.push({ lat, lng, speed, epoch });
  }
  normalized.sort((a, b) => a.epoch - b.epoch);
  const rawKm = routeKm(normalized);
  const unique: Point[] = [];
  let conflictingTimes = 0;
  for (const point of normalized) {
    const previous = unique.at(-1);
    if (!previous || point.epoch !== previous.epoch) { unique.push(point); continue; }
    rejectedPointCount++;
    // A current moving fix wins over a cached stopped fix at the same timestamp.
    if ((previous.speed ?? 0) <= 0 && (point.speed ?? 0) > 0) unique[unique.length - 1] = point;
    else if ((previous.speed ?? 0) > 0 && (point.speed ?? 0) > 0 && haversineKm(previous, point) > POSITION_TOLERANCE_KM) conflictingTimes++;
  }
  const stationaryPointCount = unique.filter(point => point.speed === 0).length;
  const unknownSpeedCount = unique.filter(point => point.speed === null).length;
  const originalMoving = unique.filter(point => point.speed !== null && point.speed > 0);
  let moving = originalMoving;
  // Remove an isolated moving spike only when both adjacent legs are impossible and the bypass is plausible.
  for (let pass = 0; pass < 3 && moving.length > 2; pass++) {
    const kept = [moving[0]];
    let removed = 0;
    for (let index = 1; index < moving.length - 1; index++) {
      const a = kept[kept.length - 1], b = moving[index], c = moving[index + 1];
      if (c.epoch - a.epoch <= 120 && !plausible(a, b) && !plausible(b, c) && plausible(a, c)) { removed++; rejectedPointCount++; }
      else kept.push(b);
    }
    kept.push(moving[moving.length - 1]); moving = kept;
    if (!removed) break;
  }
  const pointIndex = new Map(unique.map((point, index) => [point, index]));
  let km = 0, rejectedSegments = conflictingTimes;
  for (let index = 1; index < moving.length; index++) {
    const a = moving[index - 1], b = moving[index];
    const distance = haversineKm(a, b), seconds = b.epoch - a.epoch;
    // A long stop at the same place is fine. Do not invent a route through a material recording gap.
    let recordedStop = true;
    if (seconds > 300) {
      const from = pointIndex.get(a)!, to = pointIndex.get(b)!;
      let stoppedFixes = 0;
      for (let cursor = from + 1; cursor <= to; cursor++) {
        if (unique[cursor].epoch - unique[cursor - 1].epoch > 900) recordedStop = false;
        if (cursor < to && unique[cursor].speed === 0) stoppedFixes++;
      }
      recordedStop = recordedStop && stoppedFixes >= 2;
    }
    if (!plausible(a, b) || (seconds > 300 && (distance > 0.25 || !recordedStop))) { rejectedSegments++; continue; }
    km += distance;
  }
  const parked = originalMoving.length === 0 && unknownSpeedCount === 0 && unique.length >= 2 && unique.every(point => haversineKm(unique[0], point) <= 0.05);
  const movingCoverage = originalMoving.length ? moving.length / originalMoving.length : parked ? 1 : 0;
  const distanceReliable = unique.length >= 2 && (parked || moving.length >= 2) && rejectedSegments === 0 && movingCoverage >= 0.95 && unknownSpeedCount / Math.max(1, unique.length) <= 0.05;
  const filtered = rejectedPointCount > 0 || rawKm - km > Math.max(0.5, km * 0.02);
  const quality = !distanceReliable ? 'needs_review' as const : filtered ? 'filtered' as const : 'clean' as const;
  let qualityReason = 'Distance calculated from timestamped moving GPS fixes; stopped readings do not add kilometres.';
  if (parked) qualityReason = 'Stationary GPS history: no movement recorded.';
  if (!distanceReliable) qualityReason = unique.length < 2 ? 'Not enough valid GPS samples.' : rejectedSegments ? 'The remaining moving track has conflicting timestamps, impossible jumps or a recording gap. Distance is incomplete.' : 'There are not enough consistent moving fixes or speed readings to calculate this day reliably.';
  let movingSeconds = 0;
  for (let index = 1; index < unique.length; index++) {
    const a = unique[index - 1], b = unique[index], gap = b.epoch - a.epoch;
    if (gap > 0 && gap <= 300 && ((a.speed ?? 0) > 0 || (b.speed ?? 0) > 0)) movingSeconds += gap;
  }
  // The same cleaned coordinates feed Tracking and the report, avoiding the old back-and-forth map spikes.
  const displayPoints = parked ? unique.slice(0, 1) : moving;
  return {
    points: displayPoints.map(({ lat, lng }) => ({ lat, lng })),
    summary: {
      km: rounded(km), rawKm: rounded(rawKm), maxSpeed: unique.reduce((max, point) => Math.max(max, point.speed ?? 0), 0),
      movingMinutes: Math.round(movingSeconds / 60), pointCount: unique.length,
      acceptedPointCount: parked ? unique.length : moving.length, rejectedPointCount, stationaryPointCount,
      lateNight: moving.some(point => { const hour = Math.floor((point.epoch + 19800) / 3600) % 24; return hour >= 22 || hour < 5; }),
      distanceReliable, rejectedSegments, quality, qualityReason, algorithmVersion: ALGORITHM
    } satisfies WheelseyeMovementSummary
  };
}
function dayEpochRange(date: string) {
  const from = Date.parse(`${date}T00:00:00+05:30`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(from) || new Date(from + 19800_000).toISOString().slice(0, 10) !== date) throw new Error('Choose a valid movement date.');
  return { fromTime: from / 1000, toTime: from / 1000 + 86399 };
}
function plausible(a: Point, b: Point) {
  return b.epoch > a.epoch && haversineKm(a, b) <= MAX_SPEED * (b.epoch - a.epoch) / 3600 + POSITION_TOLERANCE_KM;
}
function routeKm(points: Point[]) {
  let km = 0;
  for (let index = 1; index < points.length; index++) km += haversineKm(points[index - 1], points[index]);
  return km;
}
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const radians = Math.PI / 180;
  const value = Math.sin((b.lat - a.lat) * radians / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((b.lng - a.lng) * radians / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, value)));
}

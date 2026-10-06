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
  idleMinutes?: number;
  stoppedMinutes?: number;
  unknownMinutes?: number;
  stopUnknownMinutes?: number;
  pointCount: number;
  acceptedPointCount: number;
  rejectedPointCount: number;
  stationaryPointCount: number;
  lateNight: boolean;
  firstMovingAt: string | null;
  lastMovingAt: string | null;
  firstMovingLatitude: number | null;
  firstMovingLongitude: number | null;
  distanceReliable: boolean;
  rejectedSegments: number;
  quality: 'clean' | 'filtered' | 'needs_review';
  qualityReason: string;
  algorithmVersion: string;
};
type Point = { lat: number; lng: number; speed: number | null; epoch: number; ignition: boolean | null };
export type MovementEvent = { kind: "moving" | "idle" | "stopped" | "stop_unknown" | "gap"; from: string; to: string; minutes: number; lat: number; lng: number; endLat: number; endLng: number; distanceKm?: number; cumulativeKm?: number; distanceIncomplete?: boolean };
export type MovementProgressPoint = { at:string; lat:number; lng:number; speed:number|null; kind:MovementEvent["kind"]|"start"; addedKm:number|null; cumulativeKm:number; distanceFrom:string|null; afterHours:boolean; gapBefore:boolean };
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
    normalized.push({ lat, lng, speed, epoch, ignition: point.ignition === true || point.ignition === 1 ? true : point.ignition === false || point.ignition === 0 ? false : null });
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
  const acceptedLegs = new Map<number,{km:number;from:number}>();
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
    acceptedLegs.set(b.epoch,{km:distance,from:a.epoch});
  }
  const parked = originalMoving.length === 0 && unknownSpeedCount === 0 && unique.length >= 2 && unique.every(point => haversineKm(unique[0], point) <= 0.05);
  const movingCoverage = originalMoving.length ? moving.length / originalMoving.length : parked ? 1 : 0;
  const distanceReliable = unique.length >= 2 && (parked || moving.length >= 2) && rejectedSegments === 0 && movingCoverage >= 0.95 && unknownSpeedCount / Math.max(1, unique.length) <= 0.05;
  const filtered = rejectedPointCount > 0 || rawKm - km > Math.max(0.5, km * 0.02);
  const quality = !distanceReliable ? 'needs_review' as const : filtered ? 'filtered' as const : 'clean' as const;
  let qualityReason = 'Distance calculated from timestamped moving GPS fixes; stopped readings do not add kilometres.';
  if (parked) qualityReason = 'Stationary GPS history: no movement recorded.';
  if (!distanceReliable) qualityReason = unique.length < 2 ? 'Not enough valid GPS samples.' : rejectedSegments ? 'The remaining moving track has conflicting timestamps, impossible jumps or a recording gap. Distance is incomplete.' : 'There are not enough consistent moving fixes or speed readings to calculate this day reliably.';
  // Invalid jumps and recording gaps never become driving or idle time.
  const events: MovementEvent[] = [];
  const secondsByKind = { moving: 0, idle: 0, stopped: 0, stop_unknown: 0, gap: 0 };
  const validMoving = new Set(moving);
  // Some devices interleave cached stopped coordinates with current moving fixes.
  // Remove only a stationary fix with impossible legs to BOTH nearby moving neighbours.
  let nextMoving: Point | null = null;
  const nextByIndex: Array<Point|null> = [];
  for(let i=unique.length-1;i>=0;i--){nextByIndex[i]=nextMoving;if(validMoving.has(unique[i]))nextMoving=unique[i];}
  let previousMoving: Point | null = null;
  const timelinePoints=unique.filter((point,index)=>{
    if((point.speed??0)>0){if(!validMoving.has(point))return false;previousMoving=point;return true;}
    const next=nextByIndex[index];
    return !(point.speed===0&&previousMoving&&next&&point.epoch-previousMoving.epoch<=300&&next.epoch-point.epoch<=300&&!plausible(previousMoving,point)&&!plausible(point,next));
  });
  const progress: MovementProgressPoint[] = [];
  let runningKm = 0, eventStartKm = 0;
  const precision=(value:number)=>Math.round(value*1000)/1000;
  const isAfterHours=(epoch:number)=>{const hour=Math.floor((epoch+19800)/3600)%24;return hour>=22||hour<5;};
  const observation=(point:Point,kind:MovementProgressPoint['kind']):MovementProgressPoint=>{
    const leg=acceptedLegs.get(point.epoch);
    runningKm+=leg?.km??0;
    return {at:new Date(point.epoch*1000).toISOString(),lat:point.lat,lng:point.lng,speed:point.speed,kind:kind==='start'?'start':point.speed===null?'gap':point.speed>0?'moving':point.ignition===true?'idle':point.ignition===false?'stopped':'stop_unknown',
      addedKm:kind==='gap'&&!leg?null:precision(leg?.km??0),cumulativeKm:precision(runningKm),
      distanceFrom:leg?new Date(leg.from*1000).toISOString():null,afterHours:isAfterHours(point.epoch),gapBefore:kind==='gap'};
  };
  if(timelinePoints.length)progress.push(observation(timelinePoints[0],'start'));
  const routeSegments: Array<Array<{lat:number;lng:number}>> = [];
  let segment: Array<{lat:number;lng:number}> = [];
  for (let index = 1; index < timelinePoints.length; index++) {
    const a = timelinePoints[index - 1], b = timelinePoints[index], seconds = b.epoch - a.epoch;
    const stopped = a.speed === 0 && b.speed === 0 && haversineKm(a,b) <= 0.05;
    const invalid = seconds > 300 || !plausible(a,b) || a.speed === null || b.speed === null ||
      ((a.speed ?? 0) > 0 && !validMoving.has(a)) || ((b.speed ?? 0) > 0 && !validMoving.has(b)) ||
      (a.speed === 0 && b.speed === 0 && !stopped);
    const kind: MovementEvent['kind'] = invalid ? 'gap' : stopped ?
      a.ignition === true && b.ignition === true ? 'idle' : a.ignition === false && b.ignition === false ? 'stopped' : 'stop_unknown' : 'moving';
    secondsByKind[kind] += seconds;
    const reading=observation(b,kind);progress.push(reading);
    const previous = events.at(-1);
    if (previous && previous.kind === kind && (kind === 'moving' || kind === 'gap' || haversineKm(previous,a) <= 0.05)) {
      previous.to = new Date(b.epoch*1000).toISOString(); previous.minutes += seconds/60;
      previous.endLat = b.lat; previous.endLng = b.lng;
      previous.distanceKm=precision(reading.cumulativeKm-eventStartKm);previous.cumulativeKm=reading.cumulativeKm;previous.distanceIncomplete=previous.distanceIncomplete||kind==='gap';
    } else {eventStartKm=progress[progress.length-2].cumulativeKm;events.push({kind,from:new Date(a.epoch*1000).toISOString(),to:new Date(b.epoch*1000).toISOString(),minutes:seconds/60,lat:a.lat,lng:a.lng,endLat:b.lat,endLng:b.lng,distanceKm:precision(reading.cumulativeKm-eventStartKm),cumulativeKm:reading.cumulativeKm,distanceIncomplete:kind==='gap'});}
    if (kind === 'gap') { if (segment.length) routeSegments.push(segment); segment = []; }
    else { if (!segment.length) segment.push({lat:a.lat,lng:a.lng}); segment.push({lat:b.lat,lng:b.lng}); }
  }
  if (segment.length) routeSegments.push(segment);
  // The same cleaned coordinates feed Tracking and the report, avoiding the old back-and-forth map spikes.
  const displayPoints = parked ? unique.slice(0, 1) : moving;
  return {
    progress,
    timeline: events.map(event=>({...event,minutes:rounded(event.minutes)})),
    routeSegments,
    points: displayPoints.map(({ lat, lng }) => ({ lat, lng })),
    afterHours: moving.filter(point=>{const hour=Math.floor((point.epoch+19800)/3600)%24;return hour>=22||hour<5;}).map(point=>({lat:point.lat,lng:point.lng,speed:point.speed,at:new Date(point.epoch*1000).toISOString()})),
    summary: {
      km: rounded(km), rawKm: rounded(rawKm), maxSpeed: unique.reduce((max, point) => Math.max(max, point.speed ?? 0), 0),
      movingMinutes: Math.round(secondsByKind.moving / 60), idleMinutes: Math.round(secondsByKind.idle / 60), stoppedMinutes: Math.round(secondsByKind.stopped / 60), stopUnknownMinutes: Math.round(secondsByKind.stop_unknown / 60), unknownMinutes: Math.round(secondsByKind.gap / 60), pointCount: unique.length,
      acceptedPointCount: parked ? unique.length : moving.length, rejectedPointCount, stationaryPointCount,
      lateNight: moving.some(point => { const hour = Math.floor((point.epoch + 19800) / 3600) % 24; return hour >= 22 || hour < 5; }),
      firstMovingAt: moving.length ? new Date(moving[0].epoch * 1000).toISOString() : null,
      lastMovingAt: moving.length ? new Date(moving.at(-1)!.epoch * 1000).toISOString() : null,
      firstMovingLatitude: moving[0]?.lat ?? null,
      firstMovingLongitude: moving[0]?.lng ?? null,
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

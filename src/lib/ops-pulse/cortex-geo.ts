export type Point = [number, number];
export type TimedPoint = { point: Point; time: number };

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

export function distanceKm(a: Point, b: Point) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b[0] - a[0]) * r) / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Clean Amazon locationsByTime into a chronological Driver Trace. */
export function cleanGpsTrail(
  rows: any[] | null | undefined,
  transporterId: string,
  date: string,
): TimedPoint[] {
  if (!Array.isArray(rows) || !transporterId || rows.length > 50000) return [];
  const start = Date.parse(`${date}T00:00:00+05:30`);
  if (!Number.isFinite(start)) return [];

  const sorted = rows
    .filter((r) => String(r?.transporterId || "") === transporterId)
    .map((r) => {
      const point = asLatLng(r?.geocode?.latitude, r?.geocode?.longitude);
      const time = Number(r?.epochTimestamp);
      return point && Number.isFinite(time) ? { point, time } : null;
    })
    .filter((p): p is TimedPoint => Boolean(p))
    .filter((p) => p.time >= start && p.time < start + 86400000)
    .sort((a, b) => a.time - b.time);

  const unique: TimedPoint[] = [];
  for (const p of sorted) {
    const last = unique.at(-1);
    if (last && last.time === p.time) {
      if (distanceKm(last.point, p.point) > 0.02) return [];
      continue;
    }
    unique.push(p);
  }

  return unique.filter((p, i) => {
    const a = unique[i - 1];
    const b = unique[i + 1];
    if (!a || !b || b.time - a.time > 60000) return true;
    const speed = (x: TimedPoint, y: TimedPoint) =>
      (distanceKm(x.point, y.point) * 3600000) / (y.time - x.time);
    return !(speed(a, p) > 100 && speed(p, b) > 100 && speed(a, b) <= 90);
  });
}

/** Drop gap-jumps when drawing so the polyline follows roads, not air bridges. */
export function trailSegments(trace: TimedPoint[]): Point[][] {
  if (!trace.length) return [];
  const segments: Point[][] = [];
  let current: Point[] = [trace[0].point];
  for (let i = 1; i < trace.length; i++) {
    const prev = trace[i - 1];
    const next = trace[i];
    const dt = next.time - prev.time;
    const d = distanceKm(prev.point, next.point);
    const gap = dt > 60000 || (dt > 0 && (d * 3600000) / dt > 100);
    if (gap) {
      if (current.length > 1) segments.push(current);
      current = [next.point];
      continue;
    }
    current.push(next.point);
  }
  if (current.length > 1) segments.push(current);
  else if (current.length === 1 && !segments.length) segments.push(current);
  return segments;
}

export function pointAtTime(trace: TimedPoint[], time: number): Point | null {
  if (!trace.length) return null;
  if (time <= trace[0].time) return trace[0].point;
  const last = trace[trace.length - 1];
  if (time >= last.time) return last.point;

  let low = 0;
  let high = trace.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (trace[mid].time < time) low = mid + 1;
    else high = mid;
  }
  const b = trace[low];
  const a = trace[low - 1];
  if (!a || !b) return b?.point || a?.point || null;
  const span = b.time - a.time;
  if (span <= 0) return b.point;
  const t = Math.max(0, Math.min(1, (time - a.time) / span));
  return [a.point[0] + (b.point[0] - a.point[0]) * t, a.point[1] + (b.point[1] - a.point[1]) * t];
}

export function trailUpTo(trace: TimedPoint[], time: number): TimedPoint[] {
  if (!trace.length) return [];
  const cut = trace.filter((p) => p.time <= time);
  if (!cut.length) return [trace[0]];
  const tip = pointAtTime(trace, time);
  if (!tip) return cut;
  const last = cut[cut.length - 1];
  if (last.time === time) return cut;
  return [...cut, { point: tip, time }];
}

export function completionPct(
  delivered: number,
  attempted: number,
  remaining: number,
  total: number,
) {
  const d = Number(delivered) || 0;
  const denom =
    Number(total) ||
    d + (Number(attempted) || 0) + (Number(remaining) || 0);
  if (!denom) return 0;
  return Math.min(100, Math.round((d / denom) * 100));
}

export function formatIstClock(epochMs: number) {
  if (!Number.isFinite(epochMs)) return "—";
  return new Date(epochMs).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

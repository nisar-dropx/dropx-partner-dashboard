export type WheelseyeHistoryPoint = {
  longitude?: number;
  latitude?: number;
  speed?: number;
  dttimeInEpoch?: number;
  createdDateInEpoch?: number;
  ignition?: number | boolean;
  vehicleName?: string;
};

export type WheelseyeMovementSummary = {
  km: number;
  maxSpeed: number;
  movingMinutes: number;
  pointCount: number;
  lateNight: boolean;
};

export async function loadWheelseyeMovement(accessToken: string, vehicle: string, date: string) {
  const { fromTime, toTime } = dayEpochRange(date);
  const upstream = new URL("https://api.wheelseye.com/currentLocV2");
  upstream.searchParams.set("accessToken", accessToken);
  upstream.searchParams.set("searchText", vehicle);
  upstream.searchParams.set("fromTime", String(fromTime));
  upstream.searchParams.set("toTime", String(toTime));

  const response = await fetch(upstream, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || "Unable to load Wheelseye movement.");
  }

  const rawPoints: WheelseyeHistoryPoint[] = Array.isArray(payload?.Vehicle) ? payload.Vehicle : [];
  const normalized = rawPoints
    .map((point) => ({
      lat: Number(point.latitude),
      lng: Number(point.longitude),
      speed: Number(point.speed) || 0,
      epoch: Number(point.dttimeInEpoch || point.createdDateInEpoch || 0),
      ignition: point.ignition === true || point.ignition === 1
    }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .sort((a, b) => a.epoch - b.epoch);

  const points = normalized.map((point) => ({ lat: point.lat, lng: point.lng }));
  const speeds = normalized.map((point) => point.speed);

  return {
    points,
    summary: {
      km: routeKm(points),
      maxSpeed: speeds.length ? Math.max(...speeds) : 0,
      movingMinutes: movingMinutes(normalized),
      pointCount: points.length,
      lateNight: normalized.some((point) => isLateNight(point.epoch))
    }
  };
}

function dayEpochRange(date: string) {
  const from = new Date(`${date}T00:00:00+05:30`);
  const to = new Date(`${date}T23:59:59+05:30`);
  return {
    fromTime: Math.floor(from.getTime() / 1000),
    toTime: Math.floor(to.getTime() / 1000)
  };
}

function routeKm(points: Array<{ lat: number; lng: number }>) {
  let km = 0;
  for (let index = 1; index < points.length; index += 1) {
    km += haversineKm(points[index - 1], points[index]);
  }
  return Math.round(km * 10) / 10;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const earthRadiusKm = 6371;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(value));
}

function radians(value: number) {
  return (value * Math.PI) / 180;
}

function movingMinutes(points: Array<{ epoch: number; speed: number }>) {
  let seconds = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index - 1].speed <= 0 && points[index].speed <= 0) continue;
    const gap = points[index].epoch - points[index - 1].epoch;
    if (gap > 0 && gap < 3600) seconds += gap;
  }
  return Math.round(seconds / 60);
}

function isLateNight(epoch: number) {
  if (!epoch) return false;
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date(epoch * 1000)));
  return hour >= 22 || hour < 5;
}

import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import {
  cortexAmazonUrl,
  fetchCortexItinerary,
  fetchCortexSummaries,
  packageCounts,
  readCortexSession,
  transporterDisplayName,
  type CortexAuth,
} from "@/lib/ops-pulse/cortex-client";

export type CortexStationOption = {
  id: string;
  code: string;
  name: string;
  region: string;
  cluster: string;
  serviceAreaId: string;
};

export type CortexRouteRow = {
  itineraryId: string;
  transporterId: string;
  amazonName: string;
  phone: string | null;
  routeCode: string | null;
  executionStatus: string | null;
  driverSessionEnded: boolean;
  delivered: number;
  attempted: number;
  remaining: number;
  rejected: number;
  total: number;
  dropxId: string | null;
  workforceName: string | null;
  workforceId: string | null;
};

export type CortexBoard = {
  date: string;
  station: CortexStationOption;
  amazonUrl: string;
  sessionOk: boolean;
  sessionError: string | null;
  routes: CortexRouteRow[];
  metrics: {
    routes: number;
    drivers: number;
    delivered: number;
    remaining: number;
    attempted: number;
    linked: number;
    unlinked: number;
  };
};

export type CortexStopTask = {
  taskId: string;
  taskType: string | null;
  taskState: string | null;
  orderId: string | null;
  scannableId: string | null;
  actualExecutionTime: number | null;
  lat: number | null;
  lng: number | null;
};

export type CortexStop = {
  sequence: number;
  type: string | null;
  address: string;
  city: string | null;
  lat: number | null;
  lng: number | null;
  tasks: CortexStopTask[];
};

export type CortexRouteDetail = {
  itineraryId: string;
  transporterId: string;
  name: string;
  phone: string | null;
  routeCode: string | null;
  executionStatus: string | null;
  driverSessionEnded: boolean;
  delivered: number;
  attempted: number;
  remaining: number;
  total: number;
  stops: CortexStop[];
  plannedPath: [number, number][];
  actualPath: [number, number][];
};

async function loadWorkforceSessionCookie(): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from("workforce_sessions")
    .select("cookie,status,created_at")
    .eq("status", "active")
    .eq("account_key", "default")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.cookie || null;
}

async function resolveCortexAuth(): Promise<
  { ok: true; auth: CortexAuth } | { ok: false; error: string }
> {
  const cookie = await loadWorkforceSessionCookie();
  if (!cookie) {
    return {
      ok: false,
      error: "No active Amazon workforce session. Refresh the shared logistics cookie, then retry.",
    };
  }
  const session = await readCortexSession(cookie);
  if (session === "expired") {
    return {
      ok: false,
      error: "Amazon session expired. Sign in again on logistics.amazon.in so Ops can refresh the cookie.",
    };
  }
  return { ok: true, auth: { cookie, session } };
}

export async function loadCortexStations(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean,
): Promise<CortexStationOption[]> {
  if (!supabaseAdmin) return [];
  const scope = await loadCodLocations(companyId, locationScopeIds, hasAllLocationAccess);
  const amazonStations = scope.locations.filter(isAmazonEdspXptLocation);
  if (!amazonStations.length) return [];

  const { data: settings } = await supabaseAdmin
    .from("workforce_amazon_station_settings")
    .select("station_id,amazon_service_area_id,service_area_code")
    .eq("company_id", companyId)
    .in(
      "station_id",
      amazonStations.map((s) => s.id),
    );

  const areaByStation = new Map(
    (settings || [])
      .filter((r) => r.amazon_service_area_id)
      .map((r) => [r.station_id as string, String(r.amazon_service_area_id)]),
  );

  // Fallback: stations.amazon_service_area_id when present on the stations table.
  const missing = amazonStations.filter((s) => !areaByStation.has(s.id)).map((s) => s.id);
  if (missing.length) {
    const { data: stationAreas } = await supabaseAdmin
      .from("stations")
      .select("id,amazon_service_area_id")
      .eq("company_id", companyId)
      .in("id", missing);
    for (const row of stationAreas || []) {
      if (row.amazon_service_area_id) areaByStation.set(row.id, String(row.amazon_service_area_id));
    }
  }

  return amazonStations
    .map((s) => {
      const serviceAreaId = areaByStation.get(s.id);
      if (!serviceAreaId) return null;
      return {
        id: s.id,
        code: s.station_code,
        name: s.station_name || s.station_code,
        region: s.region || "Unassigned",
        cluster: s.cluster || "Unassigned",
        serviceAreaId,
      } satisfies CortexStationOption;
    })
    .filter(Boolean)
    .sort((a, b) => a!.code.localeCompare(b!.code)) as CortexStationOption[];
}

export function pickCortexStation(
  stations: CortexStationOption[],
  requestedId: string | undefined,
): CortexStationOption | null {
  if (!stations.length) return null;
  if (requestedId) {
    const hit = stations.find((s) => s.id === requestedId);
    if (hit) return hit;
  }
  return stations[0];
}

async function linkWorkforce(
  companyId: string,
  stationId: string,
  date: string,
  transporterIds: string[],
) {
  const map = new Map<string, { id: string; name: string; dropxId: string }>();
  if (!supabaseAdmin || !transporterIds.length) return map;

  // Prefer same-day payable-distance rows (already resolved Amazon ↔ workforce).
  const { data: distanceRows } = await supabaseAdmin
    .from("workforce_route_distances")
    .select("workforce_id,transporter_id,workforce(id,full_name,dropx_id)")
    .eq("company_id", companyId)
    .eq("station_id", stationId)
    .eq("work_date", date)
    .in("transporter_id", transporterIds);

  for (const row of distanceRows || []) {
    const tid = String(row.transporter_id || "");
    const wf = Array.isArray(row.workforce) ? row.workforce[0] : row.workforce;
    if (!tid || !wf?.id || map.has(tid)) continue;
    map.set(tid, { id: wf.id, name: wf.full_name || "", dropxId: wf.dropx_id || "" });
  }

  const missing = transporterIds.filter((id) => !map.has(id));
  if (!missing.length) return map;

  // Fallback: provider_employee_id sometimes holds the Amazon transporter id.
  const { data } = await supabaseAdmin
    .from("workforce")
    .select("id,full_name,dropx_id,provider_employee_id")
    .eq("company_id", companyId)
    .eq("location_id", stationId)
    .is("deleted_at", null)
    .in("provider_employee_id", missing);
  for (const row of data || []) {
    if (!row.provider_employee_id || map.has(String(row.provider_employee_id))) continue;
    map.set(String(row.provider_employee_id), {
      id: row.id,
      name: row.full_name || "",
      dropxId: row.dropx_id || "",
    });
  }
  return map;
}

export async function loadCortexBoard(input: {
  companyId: string;
  station: CortexStationOption;
  date: string;
}): Promise<CortexBoard> {
  const amazonUrl = cortexAmazonUrl(input.date, input.station.serviceAreaId);
  const authResult = await resolveCortexAuth();
  if (!authResult.ok) {
    return {
      date: input.date,
      station: input.station,
      amazonUrl,
      sessionOk: false,
      sessionError: authResult.error,
      routes: [],
      metrics: { routes: 0, drivers: 0, delivered: 0, remaining: 0, attempted: 0, linked: 0, unlinked: 0 },
    };
  }

  const summariesRes = await fetchCortexSummaries(
    authResult.auth,
    input.date,
    input.station.serviceAreaId,
  );
  if (summariesRes.expired || !summariesRes.data) {
    return {
      date: input.date,
      station: input.station,
      amazonUrl,
      sessionOk: false,
      sessionError:
        "Amazon rejected the itinerary request. Refresh the shared workforce cookie and try again.",
      routes: [],
      metrics: { routes: 0, drivers: 0, delivered: 0, remaining: 0, attempted: 0, linked: 0, unlinked: 0 },
    };
  }

  const summaries = summariesRes.data;
  const transporters = new Map<string, any>();
  for (const t of summaries.transporters || []) transporters.set(t.transporterId, t);
  const stubs: any[] = summaries.itinerarySummaries || [];
  const transporterIds = [...new Set(stubs.map((s) => String(s.transporterId || "")).filter(Boolean))];
  const linked = await linkWorkforce(input.companyId, input.station.id, input.date, transporterIds);

  const routes: CortexRouteRow[] = stubs.map((stub) => {
    const transporterId = String(stub.transporterId || "");
    const person = transporters.get(transporterId);
    const pkg = packageCounts(stub.packageSummary || stub.ndPackageSummary);
    const wf = linked.get(transporterId);
    return {
      itineraryId: String(stub.itineraryId),
      transporterId,
      amazonName: transporterDisplayName(person, transporterId),
      phone: person?.workPhoneNumber || null,
      routeCode: stub.routeCode || null,
      executionStatus: stub.executionStatus || null,
      driverSessionEnded: Boolean(stub.driverSessionEnded),
      delivered: pkg.delivered,
      attempted: pkg.attempted,
      remaining: pkg.remaining,
      rejected: pkg.rejected,
      total: pkg.total,
      dropxId: wf?.dropxId || null,
      workforceName: wf?.name || null,
      workforceId: wf?.id || null,
    };
  });

  routes.sort(
    (a, b) =>
      (b.remaining - a.remaining) ||
      (a.workforceName || a.amazonName).localeCompare(b.workforceName || b.amazonName),
  );

  const drivers = new Set(routes.map((r) => r.transporterId));
  const metrics = {
    routes: routes.length,
    drivers: drivers.size,
    delivered: routes.reduce((s, r) => s + r.delivered, 0),
    remaining: routes.reduce((s, r) => s + r.remaining, 0),
    attempted: routes.reduce((s, r) => s + r.attempted, 0),
    linked: routes.filter((r) => r.workforceId).length,
    unlinked: routes.filter((r) => !r.workforceId).length,
  };

  return {
    date: input.date,
    station: input.station,
    amazonUrl,
    sessionOk: true,
    sessionError: null,
    routes,
    metrics,
  };
}

export async function loadCortexRouteDetail(input: {
  companyId: string;
  locationScopeIds: string[];
  hasAllLocationAccess: boolean;
  stationId: string;
  date: string;
  itineraryId: string;
}): Promise<CortexRouteDetail> {
  const stations = await loadCortexStations(
    input.companyId,
    input.locationScopeIds,
    input.hasAllLocationAccess,
  );
  const station = stations.find((s) => s.id === input.stationId);
  if (!station) throw new Error("Station is outside your approved locations.");

  const authResult = await resolveCortexAuth();
  if (!authResult.ok) throw new Error(authResult.error);

  const res = await fetchCortexItinerary(
    authResult.auth,
    input.itineraryId,
    station.serviceAreaId,
    input.date,
  );
  if (res.expired || !res.data) throw new Error("Amazon rejected the itinerary detail request.");

  const payload = res.data;
  const details = payload.itineraryDetails || payload;
  const addressMap = new Map<string, any>();
  for (const a of payload.addresses || []) addressMap.set(a.addressId, a);

  const plannedPath: [number, number][] = [];
  const actualPath: [number, number][] = [];
  const stops: CortexStop[] = [];
  const sorted = [...(details.stops || [])].sort(
    (a: any, b: any) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0),
  );

  for (const stop of sorted) {
    const addr = addressMap.get(stop.addressId) || {};
    const lat = addr.geocode?.latitude ?? null;
    const lng = addr.geocode?.longitude ?? null;
    const tasks: CortexStopTask[] = (stop.tasks || []).map((task: any) => {
      const geo = task.executionGeocode;
      if (geo?.latitude != null && geo?.longitude != null) {
        actualPath.push([geo.latitude, geo.longitude]);
      }
      return {
        taskId: String(task.taskId || ""),
        taskType: task.taskType || null,
        taskState: task.taskState || null,
        orderId: task.domainMap?.orderId ?? null,
        scannableId: task.domainMap?.scannableId ?? null,
        actualExecutionTime: task.actualExecutionTime ?? null,
        lat: geo?.latitude ?? null,
        lng: geo?.longitude ?? null,
      };
    });
    if (lat != null && lng != null) plannedPath.push([lat, lng]);
    const address = [addr.address1, addr.address2].filter(Boolean).join(", ");
    stops.push({
      sequence: Number(stop.sequenceNumber) || 0,
      type: stop.itineraryStopType || null,
      address: address || "Address unavailable",
      city: addr.city || null,
      lat,
      lng,
      tasks,
    });
  }

  const pkg = packageCounts(details.packageSummary || details.ndPackageSummary);
  return {
    itineraryId: String(details.itineraryId || input.itineraryId),
    transporterId: String(details.transporterId || ""),
    name: transporterDisplayName(null, String(details.transporterId || "")),
    phone: null,
    routeCode: details.routeCode || null,
    executionStatus: details.executionStatus || null,
    driverSessionEnded: Boolean(details.driverSessionEnded),
    delivered: pkg.delivered,
    attempted: pkg.attempted,
    remaining: pkg.remaining,
    total: pkg.total,
    stops,
    plannedPath,
    actualPath,
  };
}

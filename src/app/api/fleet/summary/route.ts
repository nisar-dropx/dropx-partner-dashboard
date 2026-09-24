export const dynamic = "force-dynamic";

import { fleetVehicles } from "@/data/fleet-vehicles";
import { type AuthorizationContext, getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getWheelseyeAccessToken } from "@/lib/wheelseye";

export async function GET() {
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  const companyId = requireCompanyId(authorization);
  const locationAccess = await resolveFleetLocationAccess(authorization, companyId);
  const [vehicles, locations, documentTypes, gpsLive, fuelTransactions, dailyKmRows] = await Promise.all([
    loadVehicles(companyId, locationAccess.stationCodes),
    loadLocations(companyId, locationAccess.stationCodes),
    loadDocumentTypes(companyId),
    loadWheelseyeCurrentLocations(companyId),
    loadFuelTransactions(companyId),
    loadDailyKm(companyId)
  ]);
  const visibleVehicleNos = new Set(vehicles.map((vehicle) => vehicle.vehicle_no));
  const fuelByVehicle = sumFuelByVehicle(fuelTransactions.rows);
  const kmByVehicle = sumKmByVehicle(dailyKmRows.rows);
  const vehicleMetrics = vehicles.map((vehicle) => {
    const alerts = documentAlerts(vehicle);
    const fuel = fuelByVehicle.get(vehicle.vehicle_no) ?? { litres: 0, fuelAmount: 0, txns: 0 };
    const km = kmByVehicle.get(vehicle.vehicle_no) ?? 0;
    return {
      ...vehicle,
      km,
      litres: fuel.litres,
      fuelAmount: fuel.fuelAmount,
      maintenanceAmount: 0,
      txns: fuel.txns,
      alerts,
      mileage: fuel.litres ? km / fuel.litres : 0,
      costPerKm: km ? fuel.fuelAmount / km : 0,
      healthScore: alerts.some((alert) => alert.includes("expired")) ? 60 : alerts.length ? 82 : 100
    };
  });
  const stationByVehicle = new Map(vehicles.map((vehicle) => [vehicle.vehicle_no, vehicle.station_code]));

  return Response.json({
    generatedAt: new Date().toISOString(),
    source: vehicles === fleetVehicles ? "vehicle data.xlsx" : "Supabase",
    fuelError: fuelTransactions.error,
    dailyKmError: dailyKmRows.error,
    vehicles,
    locations,
    documentTypes,
    vehicleMetrics,
    fuel: fuelTransactions.rows.filter((row) => visibleVehicleNos.has(row.vehicle_no)).map((row) => ({
      transaction_at: row.transaction_at,
      vehicle_no: row.vehicle_no,
      station_code: stationByVehicle.get(row.vehicle_no) ?? "UNMAPPED",
      source: row.provider,
      pump_name: row.station_name,
      quantity: Number(row.fuel_quantity) || 0,
      amount: Number(row.fuel_amount) || 0,
      rate: Number(row.rate) || 0
    })),
    gpsLive: filterGpsByVehicles(gpsLive, vehicles),
    maintenance: []
  });
}

type FleetLocationAccess = {
  stationCodes: string[] | null;
};

async function resolveFleetLocationAccess(authorization: AuthorizationContext, companyId: string): Promise<FleetLocationAccess> {
  if (authorization.isMasterOwner || authorization.hasAllLocationAccess) return { stationCodes: null };
  if (!supabaseAdmin || !authorization.locationScopeIds.length) return { stationCodes: [] };

  const { data, error } = await supabaseAdmin
    .from("stations")
    .select("station_code")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", authorization.locationScopeIds);

  if (error) return { stationCodes: [] };
  return {
    stationCodes: Array.from(new Set((data ?? [])
      .map((row) => String(row.station_code ?? "").trim().toUpperCase())
      .filter(Boolean)))
  };
}

async function loadDocumentTypes(companyId: string) {
  const fallback = [
    { value: "FLEET_REGISTRATION", label: "Registration", requires_expiry: true, reminder_days: 30, sort_order: 10 },
    { value: "FLEET_INSURANCE", label: "Insurance", requires_expiry: true, reminder_days: 30, sort_order: 20 },
    { value: "FLEET_PUC", label: "PUC", requires_expiry: true, reminder_days: 15, sort_order: 30 },
    { value: "FLEET_FITNESS", label: "Fitness", requires_expiry: true, reminder_days: 30, sort_order: 40 },
    { value: "FLEET_TAX", label: "Tax", requires_expiry: true, reminder_days: 30, sort_order: 50 }
  ];
  if (!supabaseAdmin) return fallback;
  const { data, error } = await supabaseAdmin
    .from("document_types")
    .select("code, name, requires_expiry, reminder_days, sort_order")
    .eq("company_id", companyId)
    .eq("document_module", "fleet")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");

  if (error || !(data ?? []).length) return fallback;
  return (data ?? []).map((row) => ({
    value: String(row.code).toUpperCase(),
    label: String(row.name),
    requires_expiry: Boolean(row.requires_expiry),
    reminder_days: Number(row.reminder_days) || 0,
    sort_order: Number(row.sort_order) || 0
  }));
}

async function loadVehicles(companyId: string, stationCodes: string[] | null) {
  if (!supabaseAdmin) return [];
  let query = supabaseAdmin
    .from("fleet_vehicles")
    .select("*")
    .eq("company_id", companyId);

  if (stationCodes) query = query.in("station_code", stationCodes.length ? stationCodes : ["__NO_ALLOCATED_LOCATION__"]);

  const { data, error } = await query
    .order("vehicle_no", { ascending: true });

  if (error) return [];
  return data;
}

async function loadLocations(companyId: string, stationCodes: string[] | null) {
  if (!supabaseAdmin) return [];
  let query = supabaseAdmin
    .from("stations")
    .select(`
      station_code,
      station_name,
      is_active,
      providers (code, name),
      location_models (code, name)
    `)
    .eq("company_id", companyId)
    .eq("is_active", true);

  if (stationCodes) query = query.in("station_code", stationCodes.length ? stationCodes : ["__NO_ALLOCATED_LOCATION__"]);

  const { data, error } = await query
    .order("station_code", { ascending: true });

  if (error) return [];
  return (data ?? []).map((row) => ({
    code: row.station_code,
    name: row.station_name,
    provider: firstRelation(row.providers)?.name ?? firstRelation(row.providers)?.code ?? "",
    model: firstRelation(row.location_models)?.name ?? firstRelation(row.location_models)?.code ?? ""
  }));
}

async function loadFuelTransactions(companyId: string) {
  if (!supabaseAdmin) return { rows: [], error: "Supabase service role is not configured." };
  const { data, error } = await supabaseAdmin
    .from("fleet_fuel_transactions")
    .select("provider, transaction_id, transaction_at, transaction_date, vehicle_no, product, station_name, station_location, fuel_quantity, fuel_amount, rate")
    .eq("company_id", companyId)
    .order("transaction_at", { ascending: false })
    .limit(1000);

  if (error) return { rows: [], error: error.message };
  return { rows: data ?? [], error: null };
}

async function loadDailyKm(companyId: string) {
  if (!supabaseAdmin) return { rows: [], error: "Supabase service role is not configured." };
  const { data, error } = await supabaseAdmin
    .from("fleet_daily_km")
    .select("vehicle_no, movement_date, km")
    .eq("company_id", companyId)
    .neq("review_status", "needs_review")
    .order("movement_date", { ascending: false })
    .limit(5000);

  if (error) return { rows: [], error: error.message };
  return { rows: data ?? [], error: null };
}

function sumFuelByVehicle(rows: Array<{ vehicle_no: string; fuel_quantity: number | string; fuel_amount: number | string }>) {
  const grouped = new Map<string, { litres: number; fuelAmount: number; txns: number }>();
  rows.forEach((row) => {
    const current = grouped.get(row.vehicle_no) ?? { litres: 0, fuelAmount: 0, txns: 0 };
    current.litres += Number(row.fuel_quantity) || 0;
    current.fuelAmount += Number(row.fuel_amount) || 0;
    current.txns += 1;
    grouped.set(row.vehicle_no, current);
  });
  return grouped;
}

function sumKmByVehicle(rows: Array<{ vehicle_no: string; km: number | string }>) {
  const grouped = new Map<string, number>();
  rows.forEach((row) => {
    grouped.set(row.vehicle_no, (grouped.get(row.vehicle_no) ?? 0) + (Number(row.km) || 0));
  });
  return grouped;
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function filterGpsByVehicles<T extends { vehicle_no: string }>(rows: T[], vehicles: Array<{ vehicle_no: string }>) {
  const allowedVehicles = new Set(vehicles.map((vehicle) => vehicle.vehicle_no));
  return rows.filter((row) => allowedVehicles.has(row.vehicle_no));
}

type VehicleDocumentDates = {
  registration_expiry: string;
  insurance_expiry: string;
  puc_expiry: string;
  fitness_expiry: string;
  tax_expiry: string;
};

const documentFields: Array<[keyof VehicleDocumentDates, string]> = [
  ["registration_expiry", "Registration"],
  ["insurance_expiry", "Insurance"],
  ["puc_expiry", "PUC"],
  ["fitness_expiry", "Fitness"],
  ["tax_expiry", "Tax"]
];

function documentAlerts(vehicle: VehicleDocumentDates) {
  const today = startOfDay(new Date());
  return documentFields.flatMap(([field, label]) => {
    const value = vehicle[field];
    if (!value || value === "As per Fitness") return [];
    const date = parseDate(value);
    if (!date) return [];
    const days = Math.ceil((date.getTime() - today.getTime()) / 86400000);
    if (days < 0) return [`${label} expired`];
    if (days <= 30) return [`${label} due ${days}d`];
    return [];
  });
}

type WheelseyeCurrentLocation = {
  vehicleNumber?: string;
  latitude?: number;
  longitude?: number;
  speed?: number;
  ignition?: boolean;
  dttime?: string;
  dttimeInEpoch?: number;
  createdDate?: number;
  createdDateReadable?: string;
};

async function loadWheelseyeCurrentLocations(companyId: string) {
  const token = await getWheelseyeAccessToken(companyId);
  if (!token) return [];

  try {
    const url = new URL("https://api.wheelseye.com/currentLoc");
    url.searchParams.set("accessToken", token);
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json();
    const list = payload?.data?.list;
    if (!response.ok || !Array.isArray(list)) return [];

    return list
      .map((item: WheelseyeCurrentLocation) => ({
        vehicle_no: String(item.vehicleNumber ?? "").trim().toUpperCase(),
        speed: Number(item.speed) || 0,
        ignition: Boolean(item.ignition),
        gps_time: normalizeWheelseyeTime(item),
        latitude: Number(item.latitude),
        longitude: Number(item.longitude)
      }))
      .filter((item: { vehicle_no: string; latitude: number; longitude: number }) => (
        item.vehicle_no && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
      ));
  } catch {
    return [];
  }
}

function normalizeWheelseyeTime(item: WheelseyeCurrentLocation) {
  const epoch = Number(item.dttimeInEpoch || item.createdDate || 0);
  if (epoch) return new Date(epoch * 1000).toISOString();
  return item.dttime || item.createdDateReadable || "";
}

function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

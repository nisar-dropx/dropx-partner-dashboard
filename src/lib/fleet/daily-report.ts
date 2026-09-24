export type ReportVehicle = { vehicle_no: string; station_code: string; model: string; fuel_type: string; status?: string | null };
export type KmRecord = { vehicle_no: string; movement_date: string; km: number | string | null; source: string; point_count: number | null; calculated_at: string; review_status?: string; raw_km?: number | string | null; accepted_point_count?: number; rejected_point_count?: number; stationary_point_count?: number; algorithm_version?: string };
export type FuelRecord = { vehicle_no: string; transaction_date: string; fuel_quantity: number | string; fuel_amount: number | string; provider: string };
export type DailyFleetRow = ReportVehicle & {
  date: string; km: number | null; litres: number | null; fuelAmount: number | null;
  mileage: number | null; costPerKm: number | null; fuelTransactions: number;
  distanceSource: string | null; pointCount: number | null; refreshedAt: string | null;
  fuelSources: string[]; rawKm: number | null; gpsQuality: string | null; acceptedPoints: number | null; rejectedPoints: number | null; stationaryPoints: number | null; dataStatus: 'gps_review' | 'ready' | 'gps_missing' | 'fuel_missing' | 'not_applicable'; provisional: boolean;
};
export type DailyFleetReport = {
  from: string; to: string; generatedAt: string; rows: DailyFleetRow[]; vehicles: ReportVehicle[];
  latestKmDate: string | null; latestFuelDate: string | null;
};
const DAY = 86_400_000;
export function istDate(now = new Date()) { return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10); }
export function shiftDay(date: string, offset: number) { return new Date(Date.parse(`${date}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10); }
export function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function validateReportRange(from: string, to: string, today = istDate(), maxDays = 93) {
  if (!validDate(from) || !validDate(to)) return 'Choose valid From and To dates.';
  if (from > to) return 'From date must be on or before To date.';
  if (to > today) return 'Future dates are not available.';
  if ((Date.parse(to) - Date.parse(from)) / DAY + 1 > maxDays) return `Choose a range of ${maxDays} days or fewer.`;
  return null;
}
export function dateDays(from: string, to: string) {
  const dates: string[] = [];
  for (let date = from; date <= to; date = shiftDay(date, 1)) dates.push(date);
  return dates;
}
const vehicleKey = (value: string) => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
function recordedKm(row: KmRecord) {
  if (row.review_status === 'needs_review') return null;
  if (row.km === null || row.km === '' || !Number.isFinite(Number(row.km)) || Number(row.km) < 0) return null;
  if (row.source.toLowerCase() === 'wheelseye' && (row.point_count ?? 0) < 2) return null;
  return Number(row.km);
}
export function buildDailyFleetRows(vehicles: ReportVehicle[], kmRows: KmRecord[], fuelRows: FuelRecord[], from: string, to: string, today = istDate()): DailyFleetRow[] {
  const rangeError = validateReportRange(from, to, today);
  if (rangeError) throw new Error(rangeError);
  const kmByDay = new Map<string, KmRecord>();
  for (const row of kmRows) {
    const key = `${vehicleKey(row.vehicle_no)}|${row.movement_date}`;
    const previous = kmByDay.get(key);
    // A missing GPS sample must not replace a valid distance; never add alternative sources together.
    const rank = (item: KmRecord) => (recordedKm(item) !== null ? 2 : 0) + (item.source.toLowerCase() === 'manual' ? 1 : 0);
    if (!previous || rank(row) > rank(previous) || (rank(row) === rank(previous) && row.calculated_at > previous.calculated_at)) kmByDay.set(key, row);
  }
  const fuelByDay = new Map<string, { litres: number; amount: number; count: number; providers: Set<string> }>();
  for (const row of fuelRows) {
    const key = `${vehicleKey(row.vehicle_no)}|${row.transaction_date}`;
    const fuel = fuelByDay.get(key) ?? { litres: 0, amount: 0, count: 0, providers: new Set<string>() };
    fuel.litres += Math.max(0, Number(row.fuel_quantity) || 0);
    fuel.amount += Math.max(0, Number(row.fuel_amount) || 0);
    fuel.count++; fuel.providers.add(row.provider); fuelByDay.set(key, fuel);
  }
  return dateDays(from, to).flatMap(date => vehicles.flatMap(vehicle => {
    const key = `${vehicleKey(vehicle.vehicle_no)}|${date}`;
    const distance = kmByDay.get(key); const fuel = fuelByDay.get(key);
    // Keep historical activity for inactive vehicles, but do not invent missing days after disposal.
    if (vehicle.status && vehicle.status.toLowerCase() !== 'active' && !distance && !fuel) return [];
    const km = distance ? recordedKm(distance) : null;
    const liquidFuel = /^(diesel|petrol)$/i.test(vehicle.fuel_type.trim());
    return [{ ...vehicle, date, km, litres: liquidFuel ? fuel?.litres ?? null : null, fuelAmount: fuel?.amount ?? null,
      mileage: liquidFuel && km !== null && fuel && fuel.litres > 0 ? km / fuel.litres : null,
      costPerKm: km !== null && km > 0 && fuel ? fuel.amount / km : null,
      fuelTransactions: fuel?.count ?? 0, distanceSource: distance?.source ?? null,
      pointCount: distance?.point_count ?? null, refreshedAt: distance?.calculated_at ?? null,
      fuelSources: [...(fuel?.providers ?? [])].sort(), rawKm: distance?.raw_km == null ? null : Number(distance.raw_km),
      gpsQuality: distance?.review_status ?? null, acceptedPoints: distance?.accepted_point_count ?? null, rejectedPoints: distance?.rejected_point_count ?? null, stationaryPoints: distance?.stationary_point_count ?? null,
      dataStatus: distance?.review_status === 'needs_review' ? 'gps_review' as const : km === null ? 'gps_missing' as const : !liquidFuel ? 'not_applicable' as const : !fuel || fuel.litres <= 0 ? 'fuel_missing' as const : 'ready' as const,
      provisional: date === today }];
  }));
}
export type SortColumn = 'date' | 'vehicle_no' | 'station_code' | 'km' | 'litres' | 'fuelAmount' | 'mileage' | 'costPerKm';
export function sortDailyRows(rows: DailyFleetRow[], column: SortColumn, direction: 'asc' | 'desc') {
  return [...rows].sort((a, b) => {
    const av = a[column], bv = b[column];
    if (av === null && bv !== null) return 1;
    if (av !== null && bv === null) return -1;
    const order = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
    return order * (direction === 'asc' ? 1 : -1) || b.date.localeCompare(a.date) || a.vehicle_no.localeCompare(b.vehicle_no);
  });
}
export function dailyFleetCsv(rows: DailyFleetRow[]) {
  const cell = (value: unknown) => {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const number = (value: number | null) => value === null ? '' : Number(value.toFixed(2));
  const data = [
    ['Date (IST)', 'Vehicle', 'Current station', 'Model', 'Fuel type', 'Distance (km)', 'Fuel purchased (L)', 'Fuel spend (INR)', 'Estimated km/L (distance / fuel purchased)', 'Fuel cost/km (INR)', 'Fuel transactions', 'Data status', 'Day status', 'Distance source', 'GPS points', 'GPS refreshed at', 'Fuel providers', 'GPS quality', 'Raw GPS distance (km, before filtering)', 'Moving/accepted GPS points', 'Invalid/outlier GPS points', 'Stationary GPS points'],
    ...rows.map(row => [row.date, row.vehicle_no, row.station_code, row.model, row.fuel_type, number(row.km), number(row.litres), number(row.fuelAmount), number(row.mileage), number(row.costPerKm), row.fuelTransactions, row.dataStatus === 'gps_review' ? 'GPS needs review' : row.dataStatus === 'gps_missing' ? 'Distance unavailable' : row.dataStatus === 'fuel_missing' ? 'No fuel recorded' : row.dataStatus === 'not_applicable' ? 'Km/L not applicable' : 'Distance + fuel available', row.provisional ? 'In progress' : 'Completed day', row.distanceSource, row.pointCount, row.refreshedAt, row.fuelSources.join(', '), row.gpsQuality === 'auto_corrected' ? 'GPS filtered' : row.gpsQuality === 'needs_review' ? 'GPS needs review' : '', number(row.rawKm), row.acceptedPoints, row.rejectedPoints, row.stationaryPoints])
  ];
  return '\uFEFF' + data.map(row => row.map(cell).join(',')).join('\r\n');
}

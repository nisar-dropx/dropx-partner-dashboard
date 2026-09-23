import { type AuthorizationContext, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { buildDailyFleetRows, type ReportVehicle, type DailyFleetReport } from './daily-report';

export class FleetReportError extends Error { constructor(message: string, public status = 500) { super(message); } }
export async function reportScope(auth: AuthorizationContext) {
  if (!hasPermission(auth, 'fleet_reports', 'access') && !hasPermission(auth, 'fleet', 'access')) throw new FleetReportError('Fleet report access denied.', 403);
  if (!supabaseAdmin) throw new FleetReportError('Fleet data is temporarily unavailable.', 503);
  const companyId = requireCompanyId(auth);
  let stationCodes: string[] | null = null;
  if (!auth.isMasterOwner && !auth.hasAllLocationAccess) {
    if (!auth.locationScopeIds.length) return { companyId, vehicles: [] as ReportVehicle[] };
    const stations = await supabaseAdmin.from('stations').select('station_code').eq('company_id', companyId).eq('is_active', true).in('id', auth.locationScopeIds);
    if (stations.error) throw new FleetReportError('Unable to check permitted locations.');
    stationCodes = (stations.data ?? []).map(row => String(row.station_code));
    if (!stationCodes.length) return { companyId, vehicles: [] as ReportVehicle[] };
  }
  let query = supabaseAdmin.from('fleet_vehicles').select('vehicle_no,station_code,model,fuel_type,status').eq('company_id', companyId).order('vehicle_no').order('id');
  if (stationCodes) query = query.in('station_code', stationCodes);
  const result = await readAllRows(query);
  if (result.error) throw new FleetReportError('Unable to load permitted vehicles.');
  return { companyId, vehicles: (result.data ?? []) as ReportVehicle[] };
}
export async function loadDailyReport(auth: AuthorizationContext, from: string, to: string): Promise<DailyFleetReport> {
  const { companyId, vehicles } = await reportScope(auth);
  const empty = { from, to, generatedAt: new Date().toISOString(), rows: [], vehicles, latestKmDate: null, latestFuelDate: null };
  if (!vehicles.length || !supabaseAdmin) return empty;
  const vehicleNos = vehicles.map(v => v.vehicle_no);
  const [km, fuel, latestKm, latestFuel] = await Promise.all([
    readAllRows(supabaseAdmin.from('fleet_daily_km').select('vehicle_no,movement_date,km,source,point_count,calculated_at,review_status,raw_km').eq('company_id', companyId).in('vehicle_no', vehicleNos).gte('movement_date', from).lte('movement_date', to).order('movement_date').order('id')),
    readAllRows(supabaseAdmin.from('fleet_fuel_transactions').select('vehicle_no,transaction_date,fuel_quantity,fuel_amount,provider').eq('company_id', companyId).in('vehicle_no', vehicleNos).gte('transaction_date', from).lte('transaction_date', to).order('transaction_date').order('id')),
    supabaseAdmin.from('fleet_daily_km').select('movement_date').eq('company_id', companyId).in('vehicle_no', vehicleNos).order('movement_date', { ascending: false }).limit(1),
    supabaseAdmin.from('fleet_fuel_transactions').select('transaction_date').eq('company_id', companyId).in('vehicle_no', vehicleNos).order('transaction_date', { ascending: false }).limit(1)
  ]);
  if (km.error || fuel.error || latestKm.error || latestFuel.error) throw new FleetReportError('Unable to load the complete distance and fuel report. Please try again.');
  return { ...empty, rows: buildDailyFleetRows(vehicles, km.data ?? [], fuel.data ?? [], from, to), latestKmDate: latestKm.data?.[0]?.movement_date ?? null, latestFuelDate: latestFuel.data?.[0]?.transaction_date ?? null };
}

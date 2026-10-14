import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { eligibleExpenseVehicle, parsePaymentVehicleScope, type ExpenseVehicle, type PaymentVehicleSnapshot } from './payment-vehicle-policy';

export async function expenseVehicles(companyId: string, station: string) {
  if (!supabaseAdmin) throw new Error('Vehicle registry unavailable.');
  // The source master is authoritative; never classify ODCD as owned from its name.
  const sources = await supabaseAdmin.from('fleet_vehicle_sources').select('id,ownership_type').eq('company_id', companyId);
  if (sources.error) throw new Error('Vehicle sources unavailable. Please retry.');
  const sourcePolicy = new Map((sources.data ?? []).map(s => [s.id, s.ownership_type]));
  const vehicles: ExpenseVehicle[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await supabaseAdmin.from('fleet_vehicles')
      .select('id,vehicle_no,model,station_code,ownership_type,source_id,status')
      .eq('company_id', companyId).eq('station_code', station).order('id').range(offset, offset + 499);
    if (result.error) throw new Error('Vehicle registry unavailable. Please retry.');
    for (const row of result.data ?? []) {
      const vehicle = { ...row, ownership_type: row.source_id ? sourcePolicy.get(row.source_id) ?? 'unknown' : row.ownership_type };
      if (eligibleExpenseVehicle(vehicle, station)) vehicles.push(vehicle);
    }
    if ((result.data?.length ?? 0) < 500) break;
  }
  return vehicles.sort((a, b) => a.vehicle_no.localeCompare(b.vehicle_no));
}

export async function paymentVehicleFields(companyId: string, station: string, scope: unknown, selectedId: FormDataEntryValue | null): Promise<{ expense_vehicle_id: string | null; expense_vehicle_snapshot: PaymentVehicleSnapshot | null }> {
  if (parsePaymentVehicleScope(scope) === 'none') return { expense_vehicle_id: null, expense_vehicle_snapshot: null };
  const vehicle = (await expenseVehicles(companyId, station)).find(v => v.id === String(selectedId ?? ''));
  if (!vehicle) throw new Error('Select a company-owned vehicle assigned to this station. Refresh if its placement has changed.');
  return { expense_vehicle_id: vehicle.id, expense_vehicle_snapshot: { id: vehicle.id, vehicle_no: vehicle.vehicle_no, model: vehicle.model, station_code: vehicle.station_code } };
}

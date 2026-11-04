import { supabaseAdmin } from '@/lib/supabase-admin';
import { prepareVanFuel } from '@/lib/van-fuel-server';
import { eligiblePaymentVehicle, paymentVehicleDetails, vehiclePaymentPolicy } from '@/lib/vehicle-payment';

export async function prepareVehiclePayment(companyId: string, code: string, station: string, form: FormData, actual: boolean, existing?: unknown, preserveVehicle = false): Promise<{ details?: Record<string, unknown> }> {
  if (code === 'ADHOC_DRIVER') {
    if (!supabaseAdmin) throw new Error('Driver directory unavailable.');
    const previous = existing && typeof existing === 'object' ? existing as Record<string, unknown> : {};
    // An approved estimate retains its person, work date and vehicle.
    if (preserveVehicle) return { details: previous };
    const candidate = { reason_key: String(form.get('driver_reason') ?? ''), work_date: String(form.get('driver_work_date') ?? ''),
      workforce_id: String(form.get('driver_workforce_id') ?? '') || null,
      vehicle_id: String(form.get('driver_vehicle_id') ?? '') || null };
    const result = await supabaseAdmin.rpc('validate_adhoc_driver_request', { p_company: companyId, p_station_code: station, p_details: candidate,
      p_request: String(form.get('request_id') ?? '') || null });
    if (result.error) throw new Error(result.error.message);
    const d = result.data;
    return { details: { ...previous, adhoc_driver: d, vehicle_no: d.vehicle_no ?? null,
      payment_vehicle: d.vehicle_id ? { vehicle_id: d.vehicle_id, vehicle_no: d.vehicle_no, station_code: station } : null } };
  }
  if (code === 'VAN_FUEL') return prepareVanFuel(companyId, code, station, form, actual, existing, preserveVehicle);
  if (!vehiclePaymentPolicy(code)) return {};
  const saved = paymentVehicleDetails(existing);
  // An approved estimate keeps its vehicle even if Fleet subsequently remaps it.
  const locked = preserveVehicle && saved && saved.station_code === station;
  const id = locked ? saved.vehicle_id : String(form.get('payment_vehicle_id') ?? '').trim();
  if (!id) throw new Error('Select a vehicle mapped to this station.');
  if (!supabaseAdmin) throw new Error('Vehicle directory unavailable.');
  let vehicle = locked ? saved : null;
  if (!vehicle) {
    const result = await supabaseAdmin.from('fleet_vehicles').select('id,vehicle_no,station_code,ownership_type').eq('company_id', companyId).eq('id', id).maybeSingle();
    if (result.error) throw new Error('Unable to validate the vehicle. Please retry.');
    if (!result.data || !eligiblePaymentVehicle(result.data, station, code)) throw new Error(vehiclePaymentPolicy(code) === 'own' ? 'Select a company-owned vehicle mapped to this station.' : 'Select a vehicle mapped to this station.');
    vehicle = { vehicle_id: result.data.id, vehicle_no: result.data.vehicle_no, station_code: station };
  }
  const previous = existing && typeof existing === 'object' ? existing as Record<string, unknown> : {};
  return { details: { ...previous, vehicle_no: vehicle.vehicle_no, payment_vehicle: vehicle } };
}

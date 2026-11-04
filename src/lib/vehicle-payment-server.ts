import { supabaseAdmin } from '@/lib/supabase-admin';
import { prepareVanFuel } from '@/lib/van-fuel-server';
import { eligiblePaymentVehicle, paymentVehicleDetails, vehiclePaymentPolicy } from '@/lib/vehicle-payment';

export async function prepareVehiclePayment(companyId: string, code: string, station: string, form: FormData, actual: boolean, existing?: unknown, preserveVehicle = false): Promise<{ details?: Record<string, unknown> }> {
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

import { vanFuelDetails } from '@/lib/van-fuel';

/** Hired adhoc vans keep their existing registration field. Generators are not vehicles. */
export function vehiclePaymentPolicy(code: string | null | undefined): 'own' | 'station' | null {
  if (['VAN_FUEL', 'VEHICLE_REPAIR', 'VEHICLE_SERVICE'].includes(code ?? '')) return 'own';
  return code === 'ADHOC_DRIVER' ? 'station' : null;
}
export type PaymentVehicle = { vehicle_id: string; vehicle_no: string; station_code: string };
export function paymentVehicleDetails(value: unknown): PaymentVehicle | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const vehicle = record.payment_vehicle as PaymentVehicle | undefined;
  return vehicle?.vehicle_id && vehicle.vehicle_no && vehicle.station_code ? vehicle : vanFuelDetails(value);
}
export function eligiblePaymentVehicle(vehicle: { ownership_type: string | null; station_code: string | null }, station: string, code: string) {
  const policy = vehiclePaymentPolicy(code);
  return Boolean(policy && vehicle.station_code === station && (policy === 'station' || vehicle.ownership_type === 'own'));
}

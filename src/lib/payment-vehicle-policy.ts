export type PaymentVehicleScope = 'none' | 'owned_station';
export function parsePaymentVehicleScope(value: unknown): PaymentVehicleScope {
  if (value == null || value === '' || value === 'none') return 'none';
  if (value === 'owned_station') return value;
  throw new Error('Choose a valid vehicle requirement.');
}
export type ExpenseVehicle = {
  id: string; vehicle_no: string; model: string | null; station_code: string;
  ownership_type: string; status: string; deleted_at?: string | null;
};
export function eligibleExpenseVehicle(vehicle: ExpenseVehicle, station: string) {
  return vehicle.station_code === station && vehicle.ownership_type === 'own' && !vehicle.deleted_at &&
    !['sold', 'disposed', 'returned', 'inactive'].includes(vehicle.status);
}
export type PaymentVehicleSnapshot = Pick<ExpenseVehicle, 'id' | 'vehicle_no' | 'model' | 'station_code'>;

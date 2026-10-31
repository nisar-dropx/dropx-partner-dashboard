export type VanFuelDetails = { vehicle_id: string; vehicle_no: string; station_code: string; fuel_date: string; litres: number | null };
export function vanFuelDetails(value: unknown): VanFuelDetails | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const fuel = record.van_fuel as VanFuelDetails | undefined;
  return fuel?.vehicle_id && fuel.vehicle_no && fuel.fuel_date ? fuel : null;
}
export function validateFuelInput(date: string, litresText: string, actual: boolean, today: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > today) throw new Error('Select a valid fuel date, today or earlier.');
  const litres = litresText.trim() ? Number(litresText) : null;
  if ((actual && litres == null) || (litres != null && (!Number.isFinite(litres) || litres <= 0 || litres > 2000))) throw new Error('Enter the fuel litres shown on the bill (greater than 0, up to 2,000).');
  return { fuel_date: date, litres };
}
export function ownStationVehicle(vehicle: { ownership_type: string | null; station_code: string | null }, station: string) {
  return vehicle.ownership_type === 'own' && vehicle.station_code === station;
}

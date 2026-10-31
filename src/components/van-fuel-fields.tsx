'use client';
import { useEffect, useState } from 'react';
import { vanFuelDetails } from '@/lib/van-fuel';

type Vehicle = { id: string; vehicle_no: string; model: string | null };
export function VanFuelFields({ locationId, actual = false, saved, preserveVehicle = false }: { locationId: string; actual?: boolean; saved?: unknown; preserveVehicle?: boolean }) {
  const initial = vanFuelDetails(saved);
  const locked = preserveVehicle && Boolean(initial);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState(initial?.vehicle_id ?? '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (locked || !locationId) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setVehicles([]);
    void fetch(`/api/payments/fuel-vehicles?location=${encodeURIComponent(locationId)}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load vehicles.');
      setVehicles(result.vehicles);
      setVehicleId(current => result.vehicles.some((vehicle: Vehicle) => vehicle.id === current) ? current : '');
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [locationId, locked, attempt]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return <section aria-label="Van fuel details" className="van-fuel-fields">
    <div className="form-grid three">
      <label>Company-owned vehicle *{locked ? <><input className="field" readOnly value={initial!.vehicle_no} /><input type="hidden" name="fuel_vehicle_id" value={initial!.vehicle_id} /></> : <select aria-label="Company-owned vehicle" className="field" name="fuel_vehicle_id" required value={vehicleId} onChange={event => setVehicleId(event.target.value)}>
        <option value="">{!locationId ? 'Select station first' : loading ? 'Loading vehicles…' : !vehicles.length ? 'No company-owned vehicles mapped' : 'Select vehicle'}</option>
        {vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicle_no}{vehicle.model ? ` · ${vehicle.model}` : ''}</option>)}
      </select>}<small className="helper-text">Company-owned · selected station only</small></label>
      <label>Fuel date *<input className="field" type="date" name="fuel_date" required max={today} defaultValue={initial?.fuel_date ?? today} readOnly={locked} /></label>
      <label>Fuel litres{actual ? ' *' : ''}<input className="field" type="number" name="fuel_litres" required={actual} min="0.01" max="2000" step="0.01" defaultValue={initial?.litres ?? ''} placeholder={actual ? 'As shown on bill' : 'If already filled'} /><small className="helper-text">Approved bills appear in this vehicle’s Fleet fuel log.</small></label>
    </div>
    {error ? <p role="alert">{error} <button className="button secondary compact" type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : null}
  </section>;
}

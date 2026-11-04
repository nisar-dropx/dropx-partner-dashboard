'use client';
import { AdhocDriverFields } from '@/components/adhoc-driver-fields';
import { useEffect, useState } from 'react';
import { vanFuelDetails } from '@/lib/van-fuel';
import { paymentVehicleDetails, vehiclePaymentPolicy } from '@/lib/vehicle-payment';

type Vehicle = { id: string; vehicle_no: string; model: string | null };
function StandardVehiclePaymentFields({ headCode, locationId, actual = false, saved, preserveVehicle = false }: { headCode: string; locationId: string; actual?: boolean; saved?: unknown; preserveVehicle?: boolean }) {
  const fuel = headCode === 'VAN_FUEL';
  const ownOnly = vehiclePaymentPolicy(headCode) === 'own';
  const initialFuel = vanFuelDetails(saved);
  const initial = paymentVehicleDetails(saved);
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
    void fetch(`/api/payments/fuel-vehicles?location=${encodeURIComponent(locationId)}&head=${encodeURIComponent(headCode)}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load vehicles.');
      setVehicles(result.vehicles);
      setVehicleId(current => result.vehicles.some((vehicle: Vehicle) => vehicle.id === current) ? current : '');
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [locationId, locked, attempt, headCode]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return <section aria-label="Vehicle details" className="van-fuel-fields">
    <div className={fuel ? "form-grid three" : "form-grid"}>
      <label>Vehicle number *{locked ? <><input className="field" readOnly value={initial!.vehicle_no} /><input type="hidden" name={fuel ? "fuel_vehicle_id" : "payment_vehicle_id"} value={initial!.vehicle_id} /></> : <select aria-label="Vehicle number" className="field" name={fuel ? "fuel_vehicle_id" : "payment_vehicle_id"} required value={vehicleId} onChange={event => setVehicleId(event.target.value)}>
        <option value="">{!locationId ? 'Select station first' : loading ? 'Loading vehicles…' : !vehicles.length ? 'No eligible vehicles mapped' : 'Select vehicle'}</option>
        {vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicle_no}{vehicle.model ? ` · ${vehicle.model}` : ''}</option>)}
      </select>}<small className="helper-text">{ownOnly ? "Company-owned · selected station only" : "Selected station vehicles"}</small></label>
      {fuel ? <><label>Fuel date *<input className="field" type="date" name="fuel_date" required max={today} defaultValue={initialFuel?.fuel_date ?? today} readOnly={locked} /></label>
      <label>Fuel litres{actual ? ' *' : ''}<input className="field" type="number" name="fuel_litres" required={actual} min="0.01" max="2000" step="0.01" defaultValue={initialFuel?.litres ?? ''} placeholder={actual ? 'As shown on bill' : 'If already filled'} /><small className="helper-text">Approved bills appear in this vehicle’s Fleet fuel log.</small></label></> : null}
    </div>
    {error ? <p role="alert">{error} <button className="button secondary compact" type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : null}
  </section>;
}

export function VehiclePaymentFields(props: Parameters<typeof StandardVehiclePaymentFields>[0]) {
  return props.headCode === 'ADHOC_DRIVER' ? <AdhocDriverFields locationId={props.locationId} saved={props.saved} locked={props.preserveVehicle} /> : <StandardVehiclePaymentFields {...props} />;
}

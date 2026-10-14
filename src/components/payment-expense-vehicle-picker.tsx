'use client';
import { useEffect, useState } from 'react';
import { SearchableSelect } from './searchable-select';
import type { ExpenseVehicle } from '@/lib/payment-vehicle-policy';

export function PaymentExpenseVehiclePicker({ locationId, disabled = false }: { locationId: string; disabled?: boolean }) {
  const [vehicles, setVehicles] = useState<ExpenseVehicle[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setVehicles([]); setError(''); setLoading(Boolean(locationId));
    if (locationId) void fetch(`/api/payments/expense-vehicles?location=${encodeURIComponent(locationId)}`, { signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Vehicles unavailable.'); return data; })
      .then(data => { if (!controller.signal.aborted) setVehicles(data.vehicles); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message || 'Vehicles unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [locationId, attempt]);
  return <div style={{ width: '100%', maxWidth: 640, margin: '10px 0', minWidth: 0 }}>
    <label>Company-owned vehicle *
      <SearchableSelect key={`${locationId}:${attempt}`} name="expense_vehicle_id" required disabled={disabled || loading || !locationId}
        placeholder={loading ? 'Loading vehicles…' : 'Search vehicle number or model'}
        options={vehicles.map(v => ({ value: v.id, label: `${v.vehicle_no} · ${v.model || 'Model not recorded'} · ${v.station_code}`, helper: v.status }))} />
    </label>
    <span className="helper-text">Includes vehicles under service or breakdown at this station.</span>
    {error ? <div role="alert">{error} <button type="button" className="button secondary compact" onClick={() => setAttempt(n => n + 1)}>Retry</button></div> : null}
    {!loading && !error && locationId && !vehicles.length ? <p role="status">No eligible company-owned vehicles. Contact Fleet to check the station assignment.</p> : null}
  </div>;
}

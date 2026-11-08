'use client';
import { useEffect, useState } from 'react';
import {
  adhocDriverDetails,
  adhocDriverEmptyLeaveMessage,
  adhocDriverPersonFieldLabel,
  alternateAdhocDriverLeaveReason,
  peopleForAdhocDriverReason,
  type AdhocDriverPerson,
  type AdhocDriverReason
} from '@/lib/adhoc-driver';
type Vehicle = { id: string; vehicle_no: string; status: string };
export function AdhocDriverFields({ locationId, saved, locked = false }: { locationId: string; saved?: unknown; locked?: boolean }) {
  const initial = adhocDriverDetails(saved);
  const frozen = locked;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [reason, setReason] = useState(initial?.reason_key ?? '');
  const [day, setDay] = useState(initial?.work_date ?? today);
  const [person, setPerson] = useState(initial?.workforce_id ?? '');
  const [vehicle, setVehicle] = useState(initial?.vehicle_id ?? '');
  const [data, setData] = useState<{ reasons: AdhocDriverReason[]; people: AdhocDriverPerson[]; vehicles: Vehicle[] } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (frozen) return;
    setData(null); setError('');
    if (!locationId) return;
    const controller = new AbortController();
    fetch(`/api/payments/adhoc-driver-context?location=${encodeURIComponent(locationId)}&date=${encodeURIComponent(day)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async r => { const body = await r.json(); if (!r.ok) throw new Error(body.error || 'Driver directory unavailable.'); return body; })
      .then(body => {
        if (controller.signal.aborted) return;
        setData({
          reasons: Array.isArray(body?.reasons) ? body.reasons : [],
          people: Array.isArray(body?.people) ? body.people : [],
          vehicles: Array.isArray(body?.vehicles) ? body.vehicles : []
        });
      })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [locationId, day, frozen, attempt]);
  const service = reason === 'vehicle_service';
  const selectedReason = data?.reasons.find(r => r.reason_key === reason);
  const people = peopleForAdhocDriverReason(data?.people, selectedReason);
  const alternateLeave = data && !service && reason && people.length === 0
    ? alternateAdhocDriverLeaveReason(data.reasons, data.people, reason)
    : null;
  const alternateCount = alternateLeave ? peopleForAdhocDriverReason(data?.people, alternateLeave).length : 0;
  const personLabel = adhocDriverPersonFieldLabel(reason);
  if (frozen && !initial) return <small className="helper-text">Existing approved request · original details retained.</small>;
  if (frozen) return <div className="notice"><strong>{initial!.reason_label}</strong> · {initial!.work_date} · {initial!.person_name || initial!.vehicle_no}{initial!.workforce_id ? ' · Absent; day pay excluded' : ''}</div>;
  return <section aria-label="Adhoc Driver details"><div className="form-grid three">
    <label>Sub-reason *<select className="field" name="driver_reason" required value={selectedReason ? reason : ''} onChange={e => { setReason(e.target.value); setPerson(''); setVehicle(''); }}><option value="">{!locationId ? 'Select station first' : !data ? 'Loading reasons…' : 'Select reason'}</option>{data?.reasons.map(r => <option key={r.reason_key} value={r.reason_key}>{r.label}</option>)}</select></label>
    <label>Deployment date *<input className="field" name="driver_work_date" type="date" required min={initial?.work_date ?? today} max={today} value={day} onChange={e => { setDay(e.target.value); setPerson(''); setVehicle(''); }} /></label>
    {service ? <label>Vehicle under service / breakdown *<select className="field" name="driver_vehicle_id" required value={data?.vehicles.some(v => v.id === vehicle) ? vehicle : ''} onChange={e => setVehicle(e.target.value)}><option value="">{!data ? 'Loading vehicles…' : data.vehicles.length ? 'Select Fleet vehicle' : 'No eligible vehicles'}</option>{data?.vehicles.map(v => <option key={v.id} value={v.id}>{v.vehicle_no} · {v.status.replaceAll('_', ' ')}</option>)}</select></label>
      : <label>{personLabel} *<select className="field" name="driver_workforce_id" required value={people.some(p => p.id === person) ? person : ''} onChange={e => setPerson(e.target.value)}><option value="">{!reason ? 'Select sub-reason first' : !data ? 'Loading people…' : people.length ? 'Select person' : 'No eligible people'}</option>{people.map(p => <option key={p.id} value={p.id}>{p.full_name} · {p.dropx_id}</option>)}</select></label>}
  </div>{reason && !service ? <small role="note" className="helper-text">ⓘ On submission, the selected person is marked Absent for {day}. That day’s fixed / MG and per-package pay will be excluded. Recorded work or finalized pay must be reviewed first.</small> : null}
  {reason && !service && data && people.length === 0 ? <p role="alert" className="payment-form-warning">{adhocDriverEmptyLeaveMessage(reason, day, alternateLeave, alternateCount)}</p> : null}
  {service && data && data.vehicles.length === 0 ? <p role="alert" className="payment-form-warning">No Fleet vehicles at this station are marked Under service or Breakdown.</p> : null}
  {error ? <p role="alert">{error} <button type="button" className="button secondary compact" onClick={() => setAttempt(a => a + 1)}>Retry</button></p> : null}</section>;
}

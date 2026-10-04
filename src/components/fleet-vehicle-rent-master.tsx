"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FleetControlVehicle } from "@/lib/fleet-control";

type Rent = { id: string; vehicle_id: string; monthly_rent: number; effective_from: string; effective_to: string | null; reason: string; updated_at: string };
const money = (value: number) => `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export function FleetVehicleRentMaster({ vehicles, today, canEdit }: { vehicles: FleetControlVehicle[]; today: string; canEdit: boolean }) {
  const [rates, setRates] = useState<Rent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (selected) dialog.current?.showModal(); }, [selected]);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/fleet-control/vehicle-rent", { cache: "no-store", signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw Error(data.error || "Unable to load vehicle rents."); setRates(data.rates); setError(""); })
      .catch(e => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const current = (id: string) => rates.find(r => r.vehicle_id === id && r.effective_from <= today && (!r.effective_to || r.effective_to >= today));
  const vehicle = vehicles.find(v => v.id === selected);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!vehicle || saving) return;
    const form = new FormData(event.currentTarget);
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/fleet-control/vehicle-rent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vehicleId: vehicle.id, monthlyRent: form.get("amount"), effectiveFrom: form.get("from"), reason: form.get("reason") }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error || "Unable to save rent.");
      setNotice(`Rent saved for ${vehicle.vehicleNo}. CPS will use it from ${form.get("from")}.`); setSelected(null); setReload(n => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save rent."); }
    finally { setSaving(false); }
  }
  const rows = vehicles.filter(v => `${v.vehicleNo} ${v.model} ${v.stationCode}`.toLowerCase().includes(search.toLowerCase()));
  return <article className="fc-panel fc-vehicle-rent-master">
    <div className="fc-panel-head"><div><span className="fc-eyebrow">Vehicle Master</span><h2>Vehicle rent &amp; CPS</h2><p>Monthly rent is accrued by calendar day at the deployed station. Each change has an effective date and recorded reason.</p></div><input aria-label="Search vehicle rent" placeholder="Search vehicle or station…" value={search} onChange={e => setSearch(e.target.value)} /></div>
    {error ? <div className="fc-rent-message error" role="alert">{error} <button type="button" onClick={() => setReload(n => n + 1)}>Retry loading</button></div> : null}
    {notice ? <div className="fc-rent-message" role="status">{notice}</div> : null}
    {loading ? <p className="fc-rent-message" role="status">Loading vehicle rents…</p> : !error ? <div className="fc-table-wrap"><table className="fc-table"><thead><tr><th>Vehicle</th><th>Allocated station</th><th>Deployment</th><th>Monthly rent</th><th>Effective from</th><th>Action</th></tr></thead><tbody>{rows.map(v => { const rate = current(v.id); const future = rates.find(r => r.vehicle_id === v.id && r.effective_from > today); return <tr key={v.id}><td><strong>{v.vehicleNo}</strong><small>{v.model} · {v.ownershipType}</small></td><td>{v.stationCode}</td><td>{v.deploymentStatus === "deployed" ? "Deployed" : "Not deployed"}<small>{v.statusLabel}</small></td><td>{rate ? money(rate.monthly_rent) : <span className="fc-status warn">{v.ownershipType === "odcd" ? "Through DA payout" : "Setup required"}</span>}{future ? <small>{money(future.monthly_rent)} from {future.effective_from}</small> : null}</td><td>{rate?.effective_from || "—"}</td><td><button className="fc-button secondary" type="button" onClick={() => { setSelected(v.id); setNotice(""); }}>{canEdit ? "Manage rent" : "View history"}</button></td></tr>; })}</tbody></table>{!rows.length ? <p className="fc-rent-message">No vehicles match this search.</p> : null}</div> : null}
    <p className="fc-rent-message">Initial own-vehicle rates apply from 1 September 2026. Deployed vehicles continue to accrue rent during downtime; not-deployed vehicles do not. ODCD vehicle pay stays in the workforce payout calculation.</p>
    {vehicle ? <dialog ref={dialog} className="fc-rent-editor" onCancel={event => { event.preventDefault(); if (!saving) setSelected(null); }} aria-label={`Rent for ${vehicle.vehicleNo}`}><div className="fc-panel-head"><div><h3>{vehicle.vehicleNo} · {vehicle.stationCode}</h3><p>{vehicle.model}</p></div><button type="button" className="fc-button secondary" disabled={saving} onClick={() => setSelected(null)}>Close</button></div>
      {canEdit ? <form key={vehicle.id} className="fc-add-form" onSubmit={save}><label><span>Monthly rent (₹)</span><input name="amount" type="number" step="0.01" min="0" max="9999999" required defaultValue={current(vehicle.id)?.monthly_rent ?? ""} /></label><label><span>Effective from</span><input name="from" type="date" required defaultValue={today} /></label><label className="full"><span>Reason for this rate</span><input name="reason" required minLength={3} maxLength={500} placeholder="New rent, correction or revised agreement" /></label><p className="full">The prior rate applies until the day before this date. Choosing an existing effective date corrects that rate and recalculates its period in CPS. Every save is recorded.</p><div className="fc-form-actions"><button className="fc-button primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save vehicle rent"}</button></div></form> : null}
      <div className="fc-table-wrap"><table className="fc-table"><thead><tr><th>Effective period</th><th>Monthly rent</th><th>Reason</th></tr></thead><tbody>{rates.filter(r => r.vehicle_id === vehicle.id).map(r => <tr key={r.id}><td>{r.effective_from} → {r.effective_to || "Ongoing"}</td><td>{money(r.monthly_rent)}</td><td>{r.reason}</td></tr>)}</tbody></table></div>
    </dialog> : null}
  </article>;
}

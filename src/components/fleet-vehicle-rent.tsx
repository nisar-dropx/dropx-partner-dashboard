"use client";

import { useState, type FormEvent } from "react";
import { CircleDollarSign } from "lucide-react";
import type { FleetControlVehicle } from "@/lib/fleet-control";

export function FleetVehicleRentFields({ amount, period, disabled = false }: { amount?: number | null; period?: "monthly" | "daily" | null; disabled?: boolean }) {
  return <><label><span>Rent amount (₹) · optional</span><input defaultValue={amount ?? ""} disabled={disabled} inputMode="decimal" max="9999999999.99" min="0" name="rent_amount" placeholder="Enter amount" step="0.01" type="number" /></label><label><span>Rent period</span><select defaultValue={period ?? "monthly"} disabled={disabled} name="rent_period"><option value="monthly">Per month</option><option value="daily">Per day</option></select></label></>;
}

export function FleetVehicleRentEditor({ vehicle, canEdit, onSaved }: { vehicle: FleetControlVehicle; canEdit: boolean; onSaved: (values: Pick<FleetControlVehicle, "rentAmount" | "rentPeriod">) => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/fleet/vehicles", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vehicle_no: vehicle.vehicleNo, rent_amount: form.get("rent_amount"), rent_period: form.get("rent_period") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save rent.");
      onSaved({ rentAmount: result.vehicle.rent_amount == null ? null : Number(result.vehicle.rent_amount), rentPeriod: result.vehicle.rent_period });
      setMessage({ error: false, text: result.vehicle.rent_amount == null ? "Rent removed." : "Rent saved." });
    } catch (error) { setMessage({ error: true, text: error instanceof Error ? error.message : "Could not save rent." }); }
    finally { setSaving(false); }
  }
  return <section className="fc-manage-card fc-rent-card"><div className="fc-manage-card-head"><span><CircleDollarSign size={17} /></span><div><strong>Vehicle rent</strong><small>{vehicle.rentAmount != null ? `₹${vehicle.rentAmount.toLocaleString("en-IN", { maximumFractionDigits: 2 })} per ${vehicle.rentPeriod === "daily" ? "day" : "month"}` : "No rent recorded"}</small></div></div><form className="fc-placement-form" onSubmit={save}><div className="fc-placement-grid"><FleetVehicleRentFields amount={vehicle.rentAmount} disabled={!canEdit || saving} period={vehicle.rentPeriod} /></div>{canEdit ? <><small>Used by CPS and P&L from today. Monthly rent is apportioned by calendar day. Leave blank to mark rent as pending.</small><button className="fc-button primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save rent"}</button></> : null}{message ? <p role={message.error ? "alert" : "status"} style={{ color: message.error ? "#be123c" : "#137660" }}>{message.text}</p> : null}</form></section>;
}

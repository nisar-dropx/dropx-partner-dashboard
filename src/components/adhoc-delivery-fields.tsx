"use client";

import { useEffect, useState } from "react";
import { SearchableSelect, type SearchableSelectOption } from "./searchable-select";
import type { DeliveryIdentityPolicy, DeliveryPerformerMode } from "@/lib/adhoc-delivery-identity";

type RosterResponse = { options?: SearchableSelectOption[]; client?: string; error?: string };

const modeCopy: Record<Exclude<DeliveryPerformerMode, "standalone_odcd">, { label: string; effect: string }> = {
  van_driver: { label: "Van driver performed the deliveries", effect: "The normal payout for this ID/date will be excluded." },
  bike_da: { label: "Existing bike DA performed the deliveries", effect: "Captured for audit only; the DA's normal payout remains." },
  existing_odcd: { label: "Existing ODCD accompanied the van", effect: "Only per-shipment pay remains; van rent/base pay is excluded for this date." }
};

export function AdhocDeliveryFields({ locationId, policy }: { locationId: string; policy: DeliveryIdentityPolicy }) {
  const [workDate, setWorkDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const [mode, setMode] = useState<DeliveryPerformerMode>(policy === "paid_associate_day" ? "standalone_odcd" : "van_driver");
  const [options, setOptions] = useState<SearchableSelectOption[]>([]);
  const [selected, setSelected] = useState("");
  const [manual, setManual] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setOptions([]); setSelected(""); setManual(false); setProviderId(""); setMessage(""); setLoading(Boolean(locationId && workDate));
    if (!locationId || !workDate) return;
    const query = new URLSearchParams({ location: locationId, date: workDate, strict: "1" });
    fetch(`/api/payments/adhoc-das?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as RosterResponse;
        if (!response.ok) throw new Error(body.error || "Unable to load mapped IDs.");
        if (!controller.signal.aborted) setOptions(body.options ?? []);
      })
      .catch((error) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Unable to load mapped IDs."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [locationId, workDate]);

  const effect = policy === "paid_associate_day"
    ? "This separately paid day will be excluded from the normal payout."
    : modeCopy[mode as Exclude<DeliveryPerformerMode, "standalone_odcd">].effect;

  return (
    <fieldset className="panel-body adhoc-da-fields">
      <legend>{policy === "van_execution" ? "Who performed the van deliveries?" : "Ad hoc ODCD delivery identity"}</legend>
      <input name="delivery_performer_mode" type="hidden" value={mode} />
      <div className="form-grid two">
        {policy === "van_execution" ? (
          <label>
            Delivery performer *
            <select className="field" name="delivery_performer_mode_display" onChange={(event) => setMode(event.target.value as DeliveryPerformerMode)} value={mode} required>
              {Object.entries(modeCopy).map(([value, copy]) => <option key={value} value={value}>{copy.label}</option>)}
            </select>
          </label>
        ) : null}
        <label>
          Delivery work date *
          <input className="field" name="delivery_work_date" onChange={(event) => setWorkDate(event.target.value)} required type="date" value={workDate} />
        </label>
        {!manual ? (
          <label>
            ID used / mapped owner *
            <SearchableSelect disabled={!locationId || loading} name="delivery_shipment_id" onValueChange={setSelected} options={options} placeholder={loading ? "Loading mapped IDs…" : "Search ID, name or DropX ID"} required value={selected} />
          </label>
        ) : (
          <label>
            Exact provider ID *
            <input className="field" maxLength={40} name="delivery_provider_employee_id" onChange={(event) => setProviderId(event.target.value.trim())} pattern="[A-Za-z0-9_-]{2,40}" required value={providerId} />
          </label>
        )}
      </div>
      {message ? <p role="alert">{message}</p> : null}
      <button className="button secondary compact" disabled={!locationId || loading} onClick={() => { setManual((current) => !current); setSelected(""); setProviderId(""); }} type="button">
        {manual ? "Choose mapped ID" : "Enter exact ID"}
      </button>
      <label className="check-row payment-head-option" style={{ marginTop: 12 }}>
        <input name="delivery_identity_confirmed" required type="checkbox" value="yes" />
        <span>I confirm this person used their own listed delivery ID.</span>
      </label>
      <p className="subtle">{effect} Unmapped, borrowed or ambiguous IDs cannot be cleared.</p>
    </fieldset>
  );
}

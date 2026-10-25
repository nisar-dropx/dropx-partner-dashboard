"use client";

import { useEffect, useState } from "react";
import { SearchableSelect, type SearchableSelectOption } from "./searchable-select";

type AdhocDaResponse = { options: SearchableSelectOption[]; client?: string; error?: string };
export function AdhocDaFields({ locationId }: { locationId: string }) {
  const [options, setOptions] = useState<SearchableSelectOption[]>([]);
  const [selected, setSelected] = useState("");
  const [client, setClient] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [name, setName] = useState("");
  const [workDate, setWorkDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const flipkart = client === "Flipkart";
  useEffect(() => {
    const controller = new AbortController();
    setOptions([]); setSelected(""); setMessage(""); setClient("");
    setManual(false); setProviderId(""); setName(""); setLoading(Boolean(locationId));
    if (!locationId) return;
    fetch(`/api/payments/adhoc-das?${new URLSearchParams({ location: locationId })}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const body = await response.json() as AdhocDaResponse;
        if (!response.ok) throw new Error(body.error || "Unable to load associates.");
        if (!controller.signal.aborted) { setOptions(body.options ?? []); setClient(body.client ?? ""); }
      }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [locationId]);
  return <fieldset className="panel-body adhoc-da-fields">
    <legend>Adhoc DA / Wishmaster</legend>
    <input name="adhoc_identity_mode" type="hidden" value={manual ? "manual_provider" : "latest_shipment"} />
    <div className="form-grid two">
      {!manual ? <label>{flipkart ? "Wishmaster / FHR ID" : "DA name / Provider ID"} *<SearchableSelect name="adhoc_shipment_id" options={options} value={selected} onValueChange={setSelected} placeholder={loading ? "Loading imported associates…" : "Search name or ID"} required disabled={!locationId || loading} /></label>
        : <label>{flipkart ? "FHR ID (12 digits)" : "Provider ID"} *<input className="field" name="adhoc_provider_employee_id" value={providerId} onChange={event => setProviderId(event.target.value.trim())} inputMode={flipkart ? "numeric" : "text"} pattern={flipkart ? "[0-9]{12}" : "[A-Za-z0-9_-]{2,40}"} maxLength={flipkart ? 12 : 40} required /></label>}
      <label>Work date *<input className="field" type="date" name="adhoc_work_date" value={workDate} onChange={event => setWorkDate(event.target.value)} required /></label>
      {manual ? <label>Associate name (optional)<input className="field" name="adhoc_manual_name" maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label> : null}
    </div>
    {message ? <p role="alert">{message}</p> : null}
    {!loading && locationId && !options.length && !message && !manual ? <p>No imported associates found. Enter the ID below.</p> : null}
    <button className="button secondary compact" disabled={!locationId || loading} onClick={() => { setManual(!manual); setSelected(""); }} type="button">{manual ? "Choose from imported names" : flipkart ? "Wishmaster name not reflecting" : "DA name not available"}</button>
    {manual && flipkart ? <p className="subtle">Find the 12-digit FHR ID in Casper using Aadhaar search. Enter only the FHR ID here.</p> : null}
    <p className="subtle">Once paid, this ID’s work on the selected date at this location is excluded from Workforce payout, including reports imported later.</p>
  </fieldset>;
}

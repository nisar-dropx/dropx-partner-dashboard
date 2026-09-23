"use client";

import { useEffect, useState } from "react";
import { SearchableSelect, type SearchableSelectOption } from "./searchable-select";

export function AdhocDaFields({ locationId }: { locationId: string }) {
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const [options, setOptions] = useState<SearchableSelectOption[]>([]);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [latestDate, setLatestDate] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setOptions([]); setSelected(""); setMessage(""); setLatestDate("");
    if (!locationId || !date) return;
    setLoading(true);
    fetch(`/api/payments/adhoc-das?${new URLSearchParams({ location: locationId, date })}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load station DAs.");
        if (!controller.signal.aborted) {
          setOptions(body.options);
          setLatestDate(body.latestDate || "");
          if (!body.options.length) setMessage("No shipment data for this station/date. Import the daily shipment count first.");
        }
      }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [locationId, date]);
  return <fieldset className="panel-body">
    <legend>Adhoc DA / Wishmaster</legend>
    <div className="form-grid two">
      <label>Delivery work date *<input className="field" type="date" name="adhoc_work_date" value={date} required onChange={event => { setDate(event.target.value); setSelected(""); }} /></label>
      <label>DA name / Provider ID *<SearchableSelect key={`${locationId}:${date}`} name="adhoc_shipment_id" options={options} value={selected} onValueChange={setSelected} placeholder={loading ? "Loading station DAs…" : "Search DA name or provider ID"} required /></label>
    </div>
    {!locationId ? <p>Select a location first.</p> : null}
    {message ? <p role="alert">{message}</p> : null}
    {latestDate && latestDate !== date ? <p className="subtle">Latest available shipment date: {latestDate}. <button type="button" className="button secondary compact" onClick={() => setDate(latestDate)}>Use this work date</button></p> : null}
    <p className="subtle">IDs come from this station’s daily shipment count on the selected work date. A valid Workforce mapping is required. Only processed/paid amounts are deducted once from payroll; pending or rejected requests are not deducted.</p>
  </fieldset>;
}

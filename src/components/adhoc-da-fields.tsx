"use client";

import { useEffect, useState } from "react";
import { SearchableSelect, type SearchableSelectOption } from "./searchable-select";

type AdhocDaResponse = {
  options: SearchableSelectOption[];
  workforceOptions: SearchableSelectOption[];
  error?: string;
};

export function AdhocDaFields({ locationId }: { locationId: string }) {
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const [options, setOptions] = useState<SearchableSelectOption[]>([]);
  const [workforceOptions, setWorkforceOptions] = useState<SearchableSelectOption[]>([]);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualWorkforceId, setManualWorkforceId] = useState("");
  const manualMode = Boolean(manualName && manualWorkforceId);

  useEffect(() => {
    const controller = new AbortController();
    setOptions([]); setWorkforceOptions([]); setSelected(""); setMessage("");
    setManualName(""); setManualWorkforceId(""); setManualOpen(false);
    if (!locationId) return;
    setLoading(true);
    fetch(`/api/payments/adhoc-das?${new URLSearchParams({ location: locationId })}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const body = await response.json() as AdhocDaResponse;
        if (!response.ok) throw new Error(body.error || "Unable to load station DAs.");
        if (!controller.signal.aborted) {
          setOptions(body.options ?? []);
          setWorkforceOptions(body.workforceOptions ?? []);
          if (!body.options?.length) setMessage("No imported DA names are available for this station. Use ‘DA name not available’ and enter the SCC name.");
        }
      }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [locationId]);

  function useImportedSelection(value: string) {
    setSelected(value);
    if (value) { setManualName(""); setManualWorkforceId(""); }
  }

  function confirmManual() {
    if (!manualName.trim() || !manualWorkforceId) return;
    setSelected("");
    setManualName(manualName.trim());
    setManualOpen(false);
  }

  return <fieldset className="panel-body adhoc-da-fields">
    <legend>Adhoc DA / Wishmaster</legend>
    <input name="adhoc_identity_mode" type="hidden" value={manualMode ? "manual_scc" : "latest_shipment"} />
    <input name="adhoc_manual_name" type="hidden" value={manualMode ? manualName : ""} />
    <input name="adhoc_manual_workforce_id" type="hidden" value={manualMode ? manualWorkforceId : ""} />
    <div className="form-grid adhoc-da-single-row">
      <label>DA name / Provider ID *<SearchableSelect key={`${locationId}:${manualMode}`} name="adhoc_shipment_id" options={options} value={manualMode ? "" : selected} onValueChange={useImportedSelection} placeholder={loading ? "Loading latest Amazon DA roster…" : "Search latest DA name or provider ID"} required={!manualMode} disabled={manualMode} /></label>
    </div>
    <div className="payment-form-guidance">
      <strong>Latest roster name only</strong>
      <span>The DA above comes from the latest Amazon shipment roster; that report’s date is not used. Choose the payroll recovery date separately below.</span>
    </div>
    <div className="form-grid adhoc-da-single-row">
      <label>Payroll recovery work date *<input className="field" type="date" name="adhoc_work_date" value={date} required onChange={event => setDate(event.target.value)} /></label>
    </div>
    {!locationId ? <p>Select a location first.</p> : null}
    {message ? <p role="alert">{message}</p> : null}
    {manualMode ? <div className="payment-form-guidance success"><strong>Manual SCC name selected</strong><span>{manualName} · payroll associate linked</span><button className="button secondary compact" onClick={() => setManualOpen(true)} type="button">Change</button></div> : null}
    {!manualMode ? <button className="button secondary compact" disabled={!locationId || loading} onClick={() => setManualOpen(true)} type="button">DA name not available</button> : null}

    {manualOpen ? <div className="modal-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setManualOpen(false); }}>
      <section aria-label="DA name not available" aria-modal="true" className="modal-panel adhoc-da-manual-modal" role="dialog">
        <div className="panel-head"><div><h2>DA name not available</h2><p className="subtle">Copy and paste the associate’s exact name as shown in SCC, then link the correct DropX payroll associate.</p></div><button aria-label="Close" className="modal-close" onClick={() => setManualOpen(false)} type="button">×</button></div>
        <div className="panel-body">
          <div className="form-grid two">
            <label>Exact SCC associate name *<input autoFocus className="field" onChange={event => setManualName(event.target.value)} placeholder="Paste name exactly as shown in SCC" value={manualName} /></label>
            <label>DropX payroll associate *<SearchableSelect name="adhoc_manual_workforce_picker" options={workforceOptions} value={manualWorkforceId} onValueChange={setManualWorkforceId} placeholder="Search DropX ID or associate name" /></label>
          </div>
          <div className="payment-form-guidance"><strong>Why both are required</strong><span>The SCC name is preserved for audit. The DropX associate link prevents the deduction from reaching the wrong payroll.</span></div>
          <div className="form-actions modal-actions"><button className="button secondary" onClick={() => setManualOpen(false)} type="button">Cancel</button><button className="button" disabled={!manualName.trim() || !manualWorkforceId} onClick={confirmManual} type="button">Use this associate</button></div>
        </div>
      </section>
    </div> : null}
  </fieldset>;
}

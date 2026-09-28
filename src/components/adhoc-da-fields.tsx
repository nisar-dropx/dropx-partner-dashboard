"use client";

import { useEffect, useState } from "react";
import { SearchableSelect, type SearchableSelectOption } from "./searchable-select";

type AdhocDaResponse = {
  options: SearchableSelectOption[];
  error?: string;
};

export function AdhocDaFields({ locationId }: { locationId: string }) {
  const [options, setOptions] = useState<SearchableSelectOption[]>([]);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualDraft, setManualDraft] = useState("");
  const manualMode = Boolean(manualName);

  useEffect(() => {
    const controller = new AbortController();
    setOptions([]); setSelected(""); setMessage("");
    setManualName(""); setManualDraft(""); setManualOpen(false);
    if (!locationId) return;
    setLoading(true);
    fetch(`/api/payments/adhoc-das?${new URLSearchParams({ location: locationId })}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const body = await response.json() as AdhocDaResponse;
        if (!response.ok) throw new Error(body.error || "Unable to load station DAs.");
        if (!controller.signal.aborted) {
          setOptions(body.options ?? []);
          if (!body.options?.length) setMessage("No imported DA names are available for this station. Use ‘DA name not available’ and enter the SCC name.");
        }
      }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [locationId]);

  function useImportedSelection(value: string) {
    setSelected(value);
    if (value) setManualName("");
  }

  function confirmManual() {
    if (manualDraft.trim().length < 2 || manualDraft.trim().length > 160) return;
    setSelected("");
    setManualName(manualDraft.trim());
    setManualOpen(false);
  }

  return <fieldset className="panel-body adhoc-da-fields">
    <legend>Adhoc DA / Wishmaster</legend>
    <input name="adhoc_identity_mode" type="hidden" value={manualMode ? "manual_scc" : "latest_shipment"} />
    <input name="adhoc_manual_name" type="hidden" value={manualMode ? manualName : ""} />
    <div className="form-grid adhoc-da-single-row">
      <label>DA name / Provider ID *<SearchableSelect key={`${locationId}:${manualMode}`} name="adhoc_shipment_id" options={options} value={manualMode ? "" : selected} onValueChange={useImportedSelection} placeholder={loading ? "Loading latest Amazon DA roster…" : "Search latest DA name or provider ID"} required={!manualMode} disabled={manualMode} /></label>
    </div>
    {!locationId ? <p>Select a location first.</p> : null}
    {message ? <p role="alert">{message}</p> : null}
    {manualMode ? <div className="payment-form-guidance success"><strong>SCC name selected</strong><span>{manualName}</span><button className="button secondary compact" onClick={() => { setManualDraft(manualName); setManualOpen(true); }} type="button">Change</button><button className="button secondary compact" onClick={() => setManualName("")} type="button">Choose from list</button></div> : null}
    {!manualMode ? <button className="button secondary compact" disabled={!locationId || loading} onClick={() => setManualOpen(true)} type="button">DA name not available</button> : null}

    {manualOpen ? <div className="modal-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setManualOpen(false); }}>
      <section aria-label="DA name not available" aria-modal="true" className="modal-panel adhoc-da-manual-modal" role="dialog">
        <div className="panel-head"><div><h2>DA name not available</h2><p className="subtle">Copy and paste the associate’s exact name as shown in SCC.</p></div><button aria-label="Close" className="modal-close" onClick={() => setManualOpen(false)} type="button">×</button></div>
        <div className="panel-body">
          <div className="form-grid two">
            <label>Exact SCC associate name *<input autoFocus className="field" maxLength={160} onChange={event => setManualDraft(event.target.value)} placeholder="Paste name exactly as shown in SCC" value={manualDraft} /></label>
          </div>
          <div className="form-actions modal-actions"><button className="button secondary" onClick={() => setManualOpen(false)} type="button">Cancel</button><button className="button" disabled={manualDraft.trim().length < 2 || manualDraft.trim().length > 160} onClick={confirmManual} type="button">Use this name</button></div>
        </div>
      </section>
    </div> : null}
  </fieldset>;
}

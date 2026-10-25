"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SearchableSelect, type SearchableSelectOption } from "./searchable-select";
import { fhrIdValidationMessage } from "@/lib/fhr-id-validation";

type AdhocDaResponse = { options: SearchableSelectOption[]; client?: string; error?: string };
export function AdhocDaFields({ locationId }: { locationId: string }) {
  const [options, setOptions] = useState<SearchableSelectOption[]>([]);
  const [selected, setSelected] = useState("");
  const [client, setClient] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const providerInput = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const statusId = useId();
  const [name, setName] = useState("");
  const [workDate, setWorkDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const flipkart = client === "Flipkart";
  const idError = flipkart ? fhrIdValidationMessage(providerId) : "";
  const showIdError = Boolean(idError && (idTouched || providerId));
  useEffect(() => {
    providerInput.current?.setCustomValidity(manual ? idError : "");
  }, [manual, idError]);
  useEffect(() => {
    const controller = new AbortController();
    setOptions([]); setSelected(""); setMessage(""); setClient("");
    setManual(false); setProviderId(""); setIdTouched(false); setName(""); setLoading(Boolean(locationId));
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
        : <label>{flipkart ? "FHR ID (12 digits)" : "Provider ID"} *<input
            ref={providerInput}
            className="field"
            name="adhoc_provider_employee_id"
            type="text"
            value={providerId}
            onChange={event => {
              const value = flipkart ? event.target.value : event.target.value.trim();
              event.target.setCustomValidity(flipkart ? fhrIdValidationMessage(value) : "");
              setProviderId(value);
            }}
            onBlur={() => setIdTouched(true)}
            onInvalid={() => setIdTouched(true)}
            inputMode={flipkart ? "numeric" : "text"}
            pattern={flipkart ? "[0-9]{12}" : "[A-Za-z0-9_-]{2,40}"}
            maxLength={flipkart ? undefined : 40}
            placeholder={flipkart ? "Enter 12-digit FHR ID" : "Enter provider ID"}
            aria-invalid={flipkart && showIdError ? true : undefined}
            aria-describedby={flipkart ? `${statusId} ${helpId}` : undefined}
            required
          />
          {flipkart ? <span id={statusId} role="status" aria-live="polite" style={{ fontSize: 12, fontWeight: 400, textTransform: "none", color: showIdError ? "#b42318" : undefined }}>
            {idError || "12/12 digits entered."}
          </span> : null}
        </label>}
      <label>Work date *<input className="field" type="date" name="adhoc_work_date" value={workDate} onChange={event => setWorkDate(event.target.value)} required /></label>
      {manual && !flipkart ? <label>Associate name (optional)<input className="field" name="adhoc_manual_name" maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label> : null}
    </div>
    {message ? <p role="alert">{message}</p> : null}
    {!loading && locationId && !options.length && !message && !manual ? <p>{flipkart ? 'No imported IDs found. Choose “ID not present” to enter the FHR ID.' : "No imported associates found. Enter the ID below."}</p> : null}
    <button className="button secondary compact" disabled={!locationId || loading || Boolean(message)} onClick={() => { setManual(!manual); setSelected(""); setIdTouched(false); }} type="button">{manual ? "Choose from list" : flipkart ? "ID not present" : "DA name not available"}</button>
    {manual && flipkart ? <p id={helpId} className="subtle">Search the ID owner’s Aadhaar in <a href="https://partner.ekartlogistics.com/casper/onboarding" target="_blank" rel="noopener noreferrer">Casper</a>. Copy the FHR ID from the address bar. Need help? Contact HO.</p> : null}
    <p className="subtle">Paid ad hoc days are excluded from Workforce delivery counts and daily/MG or per-packet pay.</p>
  </fieldset>;
}

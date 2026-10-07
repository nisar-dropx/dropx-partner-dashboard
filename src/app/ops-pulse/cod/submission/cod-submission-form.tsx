"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { createCodSubmission, type CodSubmissionActionState } from "./actions";
import { CodSubmitPendingOverlay } from "./cod-submit-overlay";
import { RemittanceVerifyButton } from "./remittance-verify-button";
import { useCodFormState } from "./use-cod-form-state";

type StationOption = {
  value: string;
  label: string;
  helper?: string;
  stationCode: string;
  formType: string;
  remittanceCheck: boolean;
};

const initialState: CodSubmissionActionState = { ok: false };

export function CodSubmissionForm({
  canAdd,
  client,
  defaultDepositDate,
  defaultLocationId,
  stationOptions
}: {
  canAdd: boolean;
  client: string;
  defaultDepositDate: string;
  defaultLocationId?: string;
  stationOptions: StationOption[];
}) {
  const router = useRouter();
  const [locationId, setLocationId] = useState(defaultLocationId ?? "");
  const [state, formAction] = useCodFormState(createCodSubmission, initialState);
  const selected = useMemo(
    () => stationOptions.find((option) => option.value === locationId) ?? null,
    [locationId, stationOptions]
  );
  const remittanceCheck = selected?.remittanceCheck ?? false;

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <div className="cod-form-shell" style={{ position: "relative" }}>
      {state?.error ? (
        <section className="panel message-panel error" style={{ marginBottom: 14 }}>
          <div className="panel-body">
            <strong>Action required</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{state.error}</p>
          </div>
        </section>
      ) : null}
      {state?.ok && state.notice ? (
        <section className="panel message-panel success" style={{ marginBottom: 14 }}>
          <div className="panel-body">
            <strong>Completed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{state.notice}</p>
          </div>
        </section>
      ) : null}

      <form action={formAction} className="form-grid three" encType="multipart/form-data" style={{ position: "relative" }}>
        <CodSubmitPendingOverlay
          savingLabel={remittanceCheck ? "Verifying remittance & saving…" : undefined}
          detail={remittanceCheck
            ? "Sidebar stays available. This can take a few seconds while we check Amazon portal."
            : "Uploading your slip and recording the daily update."}
        />
        {client ? <input type="hidden" name="client" value={client} /> : null}
        <input type="hidden" name="station_code" value={selected?.stationCode ?? ""} />
        <label className="span-2">Station
          <SearchableSelect
            disabled={!canAdd}
            name="location_id"
            options={stationOptions}
            defaultValue={defaultLocationId ?? ""}
            placeholder="Select station"
            required
            onValueChange={setLocationId}
          />
        </label>
        <label>Deposit Date
          <input className="field" name="deposit_date" type="date" defaultValue={defaultDepositDate} required />
        </label>
        <label>COD From
          <input className="field" name="cod_period_from" type="date" defaultValue={defaultDepositDate} required />
        </label>
        <label>COD To
          <input className="field" name="cod_period_to" type="date" defaultValue={defaultDepositDate} required />
        </label>
        <label>Deposited Amount
          <input className="field" name="deposited_amount" inputMode="decimal" placeholder="Amount deposited" required />
        </label>
        <label>Remittance Code
          <input
            className="field"
            name="remittance_code"
            placeholder="e.g. AC544759"
            required
            title="Alphanumeric remittance / CMS code"
            autoCapitalize="characters"
          />
        </label>
        <label>Submitted By
          <input
            className="field"
            name="submitter_name"
            placeholder="e.g. Ravi Kumar"
            title="Enter the person's full name — not a station code, remittance code, or Amazon portal username"
            required
          />
          <span className="subtle" style={{ display: "block", marginTop: 6 }}>
            Enter the person&apos;s actual name, not a portal username.
          </span>
        </label>
        <label className="span-2">Photo of deposit slip
          <input className="field" name="deposit_slip" type="file" accept="image/*" capture="environment" required />
          <span className="subtle" style={{ display: "block", marginTop: 6 }}>
            Upload a clear photo of the CMS / bank deposit slip (JPG or PNG only — not PDF).
          </span>
        </label>
        <label className="span-3">Remarks
          <textarea className="field" name="remarks" placeholder="Exception notes, if any" rows={3} />
        </label>
        {remittanceCheck ? <RemittanceVerifyButton /> : null}
        <p className="subtle span-3">
          {remittanceCheck
            ? "The remittance is checked on the Amazon portal when you submit. If the portal cannot be reached, your slip is still saved and the remittance can be verified later from Edit."
            : "Your slip is saved immediately; no Amazon portal check applies to this station. Slip review happens separately."}
        </p>
        <div className="form-actions span-3 align-right">
          <SubmitButton disabled={!canAdd} pendingText={remittanceCheck ? "Verifying remittance…" : "Uploading slip…"}>
            {remittanceCheck ? "Verify & submit COD" : "Upload COD slip"}
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchableSelect } from "@/components/searchable-select";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { RemittanceVerifyButton } from "./remittance-verify-button";
import { updateCodSubmission, type CodSubmissionActionState } from "./actions";
import { CodSubmitPendingOverlay } from "./cod-submit-overlay";
import { useCodFormState } from "./use-cod-form-state";

export type CodRegisterStationOption = {
  value: string;
  label: string;
  helper?: string;
  stationCode: string;
  formType: string;
};

export type CodRegisterRow = {
  id: string;
  submittedAt: string;
  stationLabel: string;
  client: string;
  formType: string;
  locationId: string;
  stationCode: string;
  codPeriod: string;
  depositDate: string;
  depositDateLabel: string;
  codPeriodFrom: string;
  codPeriodTo: string;
  remittanceCode: string;
  amount: string;
  amountRaw: string;
  submitterName: string;
  remarks: string;
  status: string;
  hasSlip: boolean;
  slipUrl: string | null;
};

const initialEditState: CodSubmissionActionState = { ok: false };

function EditSubmissionModal({
  client,
  editing,
  onClose,
  stationOptions
}: {
  client: string;
  editing: CodRegisterRow;
  onClose: () => void;
  stationOptions: CodRegisterStationOption[];
}) {
  const router = useRouter();
  const [locationId, setLocationId] = useState(editing.locationId);
  const [state, formAction] = useCodFormState(updateCodSubmission, initialEditState);
  const selected = useMemo(
    () => stationOptions.find((option) => option.value === locationId) ?? null,
    [locationId, stationOptions]
  );
  const isAmazon = selected?.formType === "amazon" || editing.formType === "amazon" || client === "amazon";

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
      onClose();
    }
  }, [state, router, onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-panel wide"
        role="dialog"
        aria-modal="true"
        aria-label="Edit COD submission"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-head toolbar">
          <div>
            <h2>Edit COD submission</h2>
            <p className="subtle">Update details and optionally replace the deposit slip photo. Amazon rows are re-verified on save.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="panel-body" style={{ position: "relative" }}>
          {state?.error ? (
            <section className="panel message-panel error" style={{ marginBottom: 12 }}>
              <div className="panel-body"><strong>Action required</strong><p className="subtle" style={{ marginTop: 6 }}>{state.error}</p></div>
            </section>
          ) : null}
          <form action={formAction} className="form-grid three" encType="multipart/form-data" style={{ position: "relative" }}>
            <CodSubmitPendingOverlay isAmazon={isAmazon} savingLabel="Saving changes…" />
            <input type="hidden" name="submission_id" value={editing.id} />
            {client ? <input type="hidden" name="client" value={client} /> : null}
            <input type="hidden" name="station_code" value={selected?.stationCode || editing.stationCode} />
            <label className="span-2">Station
              <SearchableSelect
                name="location_id"
                options={stationOptions}
                defaultValue={editing.locationId}
                placeholder="Select station"
                required
                onValueChange={setLocationId}
              />
            </label>
            <label>Deposit Date
              <input className="field" name="deposit_date" type="date" defaultValue={editing.depositDate} required />
            </label>
            <label>COD From
              <input className="field" name="cod_period_from" type="date" defaultValue={editing.codPeriodFrom || editing.depositDate} required />
            </label>
            <label>COD To
              <input className="field" name="cod_period_to" type="date" defaultValue={editing.codPeriodTo || editing.depositDate} required />
            </label>
            <label>Deposited Amount
              <input className="field" name="deposited_amount" inputMode="decimal" defaultValue={editing.amountRaw} required />
            </label>
            <label>Remittance Code
              <input className="field" name="remittance_code" defaultValue={editing.remittanceCode} required title="Alphanumeric remittance / CMS code" />
            </label>
            <label>Submitted By
              <input className="field" name="submitter_name" defaultValue={editing.submitterName} title="Letters and numbers only" />
            </label>
            <label className="span-2">Replace deposit slip photo
              <input className="field" name="deposit_slip" type="file" accept="image/*" capture="environment" />
              <span className="subtle" style={{ display: "block", marginTop: 6 }}>
                Leave empty to keep the current slip. Upload JPG/PNG only if replacing.
              </span>
            </label>
            {editing.hasSlip && editing.slipUrl ? (
              <div className="span-1" style={{ alignSelf: "end" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt="Current slip"
                  src={editing.slipUrl}
                  style={{ width: "100%", maxHeight: 120, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border, #ddd)" }}
                />
              </div>
            ) : null}
            <label className="span-3">Remarks
              <textarea className="field" name="remarks" defaultValue={editing.remarks} rows={3} />
            </label>
            {isAmazon ? <RemittanceVerifyButton /> : null}
            <div className="form-actions span-3 align-right" style={{ gap: 10 }}>
              <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
              <SubmitButton pendingText={isAmazon ? "Verifying…" : "Saving…"}>
                {isAmazon ? "Verify & save" : "Save changes"}
              </SubmitButton>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

export function CodSubmissionRegister({
  canEdit,
  client,
  rows,
  stationOptions
}: {
  canEdit: boolean;
  client: string;
  rows: CodRegisterRow[];
  stationOptions: CodRegisterStationOption[];
}) {
  const [editing, setEditing] = useState<CodRegisterRow | null>(null);
  const [preview, setPreview] = useState<CodRegisterRow | null>(null);

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Submitted</th>
              <th>Station</th>
              <th>Client</th>
              <th>COD Date</th>
              <th>Deposit Date</th>
              <th>Remittance Code</th>
              <th>Amount</th>
              <th>Slip</th>
              <th>Status</th>
              <th>Remarks</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={row.id}>
                <td>{row.submittedAt}</td>
                <td><strong>{row.stationLabel}</strong></td>
                <td>{row.client}</td>
                <td>{row.codPeriod}</td>
                <td>{row.depositDateLabel}</td>
                <td>{row.remittanceCode}</td>
                <td>{row.amount}</td>
                <td>
                  {row.hasSlip && row.slipUrl ? (
                    <button
                      type="button"
                      className="button secondary"
                      style={{ padding: "4px 8px", minHeight: 0 }}
                      onClick={() => setPreview(row)}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          alt="Deposit slip"
                          src={row.slipUrl}
                          style={{
                            width: 44,
                            height: 44,
                            objectFit: "cover",
                            borderRadius: 6,
                            border: "1px solid var(--border, #ddd)",
                            background: "#f6f6f6"
                          }}
                        />
                        Preview
                      </span>
                    </button>
                  ) : (
                    <span className="subtle">Missing</span>
                  )}
                </td>
                <td><StatusPill status={row.status} /></td>
                <td>{row.remarks || "-"}</td>
                <td>
                  {canEdit ? (
                    <button type="button" className="button secondary" style={{ padding: "4px 10px", minHeight: 0 }} onClick={() => setEditing(row)}>
                      Edit
                    </button>
                  ) : (
                    <span className="subtle">—</span>
                  )}
                </td>
              </tr>
            )) : (
              <tr><td className="empty-cell" colSpan={11}>No COD submissions found for this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {preview ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setPreview(null)}>
          <section
            className="modal-panel wide"
            role="dialog"
            aria-modal="true"
            aria-label="Deposit slip preview"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-head toolbar">
              <div>
                <h2>Deposit slip</h2>
                <p className="subtle">{preview.stationLabel} · {preview.depositDateLabel} · {preview.remittanceCode}</p>
              </div>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => setPreview(null)}>×</button>
            </div>
            <div className="panel-body" style={{ display: "grid", gap: 12 }}>
              {preview.slipUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt="Deposit slip preview"
                  src={preview.slipUrl}
                  style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: 8, background: "#111" }}
                />
              ) : null}
              <div className="modal-actions">
                {preview.slipUrl ? (
                  <a className="button secondary" href={preview.slipUrl} rel="noreferrer" target="_blank">Open full size</a>
                ) : null}
                <button type="button" className="button" onClick={() => setPreview(null)}>Close</button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {editing ? (
        <EditSubmissionModal
          client={client}
          editing={editing}
          onClose={() => setEditing(null)}
          stationOptions={stationOptions}
        />
      ) : null}
    </>
  );
}

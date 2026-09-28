"use client";

import type { PartnerOnboardingState } from "@/lib/partner-onboarding";
import { recordPartnerProgress } from "@/app/field-executive/actions";

export function PartnerProgressNote({ state, workforceId, canEdit }: {
  state: PartnerOnboardingState; workforceId: string; canEdit: boolean;
}) {
  return <div style={{ fontSize: 12, minWidth: 220, maxWidth: 300, whiteSpace: "normal", textAlign: "left", overflowWrap: "anywhere" }}>
    {state.due_kind ? <span style={{ color: "#b45309", fontWeight: 600 }} title={`${state.due_kind === "invitation_due" ? "Invitation" : "ID setup follow-up"} overdue since ${state.due_since}`}>Due · {state.due_since}</span> : null}
    <details>
      <summary style={{ cursor: "pointer", padding: "4px 0", fontWeight: 500 }}>View details</summary>
      <div style={{ padding: "8px 0", lineHeight: 1.5 }}>
        <p style={{ margin: "0 0 8px" }}>{state.instruction}</p>
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", margin: "0 0 8px" }}>
          <dt>Reported</dt><dd style={{ margin: 0 }}>{state.reported_on || "Not recorded"}</dd>
          <dt>Invitation sent</dt><dd style={{ margin: 0 }}>{state.invited_on || "Not recorded"}</dd>
          {state.report_updated_at ? <><dt>Source report</dt><dd style={{ margin: 0 }}>{new Date(state.report_updated_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}</dd></> : null}
        </dl>
        {canEdit && !state.mapping_confirmed ? <details>
          <summary style={{ cursor: "pointer" }}>Update dates</summary>
          <form action={recordPartnerProgress} style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <input name="workforce_id" type="hidden" value={workforceId} />
            <label>Actual reporting date<input type="date" name="reported_on" required defaultValue={state.reported_on || ""} /></label>
            {state.adapter === "manual" && state.registration_ready ? <label>Partner invitation sent<input type="date" name="manual_invited_on" defaultValue={state.invited_on || ""} /></label> : null}
            <button className="button secondary compact">Save dates</button>
          </form>
        </details> : null}
      </div>
    </details>
  </div>;
}

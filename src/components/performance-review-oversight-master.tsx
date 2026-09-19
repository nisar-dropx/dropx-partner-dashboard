import { SubmitButton } from "@/components/submit-button";
import type { ReviewOversightRole } from "@/lib/ops-pulse/review-oversight-roles";

export function PerformanceReviewOversightMaster({
  rows,
  error,
  canAdd,
  canEdit,
  addAction,
  updateAction,
  removeAction
}: {
  rows: ReviewOversightRole[];
  error: string | null;
  canAdd: boolean;
  canEdit: boolean;
  addAction: (formData: FormData) => void;
  updateAction: (formData: FormData) => void;
  removeAction: (formData: FormData) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Review oversight roles</h2>
          <p className="subtle">
            Anyone whose People designation or portal role matches a row below gets oversight on every station review —
            not hardcoded to Program Manager. <strong>Full</strong> can edit RCA, actions, comments and timings at any
            stage, and gets the same controls on Control Tower. <strong>Override</strong> can start, skip a level, take a
            proxy review or undo a skip, but only edits freely during their own stage.
          </p>
        </div>
      </div>
      {error ? <p className="message-panel error">{error}</p> : null}
      <div className="table-wrap">
        <table className="performance-target-master">
          <thead>
            <tr><th>Label</th><th>Matches</th><th>Tier</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td colSpan={5}>
                  <form action={updateAction} className="performance-target-row review-oversight-row">
                    <input type="hidden" name="id" value={row.id} />
                    <label><input name="label" defaultValue={row.label} disabled={!canEdit} /></label>
                    <span className="review-oversight-match">{row.matchText}</span>
                    <select name="tier" defaultValue={row.tier} disabled={!canEdit}>
                      <option value="full">Full oversight</option>
                      <option value="override">Override only</option>
                    </select>
                    <select name="is_active" defaultValue={String(row.isActive)} disabled={!canEdit}>
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </select>
                    <SubmitButton disabled={!canEdit}>Save</SubmitButton>
                  </form>
                  <form action={removeAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <SubmitButton
                      className="button danger compact"
                      confirmMessage={`Remove "${row.label}" from oversight roles? Anyone matching only this row loses oversight rights immediately.`}
                      confirmSubmitText="Remove role"
                      disabled={!canEdit}
                    >
                      Remove
                    </SubmitButton>
                  </form>
                </td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={5}>No oversight roles configured yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <form action={addAction} className="review-oversight-add">
        <label>Label<input name="label" placeholder="e.g. Regional Head" required disabled={!canAdd} /></label>
        <label>
          Matches designation/role text
          <input name="match_text" placeholder="e.g. REGIONAL HEAD" required disabled={!canAdd} />
        </label>
        <label>
          Tier
          <select name="tier" defaultValue="full" disabled={!canAdd}>
            <option value="full">Full oversight</option>
            <option value="override">Override only</option>
          </select>
        </label>
        <SubmitButton disabled={!canAdd}>Add oversight role</SubmitButton>
      </form>
    </section>
  );
}

import { digestDatabase } from "@/lib/portal-digest-delivery";
import { rosterPendencyEvents } from "@/lib/roster-pendency";
import { saveRosterPendencyDigestSettings } from "@/app/settings/notifications/actions";

export async function RosterNotificationSettings({
  companyId,
  canEdit
}: {
  companyId: string;
  canEdit: boolean;
}) {
  const db = digestDatabase();
  const [controls, history] = await Promise.all([
    db.from("portal_notification_controls").select("event_key,state,config,subject_template")
      .eq("company_id", companyId).eq("portal", "ops").in("event_key", [...rosterPendencyEvents]),
    db.from("portal_digest_deliveries").select("id,recipient_email,report_date,event_key,status,error")
      .eq("company_id", companyId).eq("portal", "ops").in("event_key", [...rosterPendencyEvents])
      .order("report_date", { ascending: false }).order("started_at", { ascending: false }).limit(40)
  ]);
  if (controls.error || history.error) {
    return (
      <section className="panel" style={{ padding: 24, marginTop: 20 }}>
        <h2>Roster pendency</h2>
        <p>Roster notification settings could not be loaded. Refresh to retry.</p>
      </section>
    );
  }
  const control = controls.data?.[0];
  return (
    <section id="roster-pendency" className="panel" style={{ padding: 24, marginTop: 20 }}>
      <h2>Roster pendency · Station + cluster managers</h2>
      <p>
        Daily morning reminder for open drafts, returned plans and awaiting-approval rosters at each manager’s stations.
        Polished HTML summary with deep links into OpsPulse. No email when there is no pendency.
      </p>
      <a className="button" href="/api/ops-pulse/roster-email-preview" target="_blank" rel="noreferrer">
        Preview manager routing (owner)
      </a>
      {control ? (
        <form action={saveRosterPendencyDigestSettings} style={{ marginTop: 18, display: "flex", gap: 14, alignItems: "end", flexWrap: "wrap" }}>
          <label>
            Morning report
            <select name="state" className="field" defaultValue={control.state} disabled={!canEdit}>
              <option value="enabled">Enabled</option>
              <option value="paused">Paused</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
          <label>
            Daily time · IST
            <input type="time" name="schedule_time" className="field" required defaultValue={String(control.config?.schedule_time || "08:00")} disabled={!canEdit} />
          </label>
          <button type="submit" className="button primary" disabled={!canEdit}>Save schedule</button>
          <small>{control.config?.delivery_ready ? "Server delivery ready" : "Pending production verification · no mail sent"}</small>
        </form>
      ) : <p>Schedule has not been installed.</p>}
      <details style={{ marginTop: 20 }}>
        <summary>Recent roster reminder deliveries</summary>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", textAlign: "left" }}>
            <thead><tr><th>Day</th><th>Manager</th><th>Status</th><th>Details</th></tr></thead>
            <tbody>
              {history.data?.map((row) => (
                <tr key={row.id}>
                  <td>{row.report_date}</td>
                  <td>{row.recipient_email}</td>
                  <td>{row.status}</td>
                  <td>{row.error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!history.data?.length ? <p>No scheduled deliveries yet.</p> : null}
      </details>
    </section>
  );
}

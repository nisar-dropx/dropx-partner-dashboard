import { reviewClock, type ReviewEddTimeline, type UtrDiscipline } from "@/lib/ops-pulse/review-operations";
import { formatDashboardDate } from "@/lib/date-format";

const count = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("en-IN");
const hours = (value: number | null) => value == null ? "—" : `${Math.floor(value / 60)}h ${value % 60}m`;

export function PerformanceEddClearanceCard({ data }: { data: { timeline: ReviewEddTimeline; error: string | null } }) {
  const { timeline: t, error } = data;
  return <details className={`performance-fact-card review-operation-card ${t.latest?.counts.todayAtStation ? "late" : ""}`} name="performance-review-fact">
    <summary aria-label="At station EDD cleared time — view half-hour history">
      <span>At station EDD cleared time</span>
      <strong>{error ? "Data unavailable" : t.summary}</strong>
      <small>{t.latest ? `Observed ${reviewClock(t.latest.observedAt)} IST${t.current ? "" : " · capture gap"}` : "06:00–EOD history"}</small>
    </summary>
    <div className="review-operation-popover">
      <header><div><b>EDD clearance · {formatDashboardDate(t.day)}</b><p>Half-hour checkpoints · all times IST</p></div><span className="review-operation-tag">Automatic</span></header>
      {error ? <p role="alert">{error}</p> : null}
      <div className="review-operation-summary"><span>Day-start EDD <b>{count(t.dayStart)}</b></span><span>Latest pending <b>{count(t.latest?.counts.hasSnapshot ? t.latest.counts.todayAtStation : null)}</b></span><span>Awaiting checks <b>{count(t.latest?.counts.hasSnapshot ? t.latest.counts.todayUnverified : null)}</b></span></div>
      <p className="review-operation-note">{t.baselineAt ? `Day-start EDD is frozen at the first morning observation (${reviewClock(t.baselineAt)}).` : "The 06:00 baseline was not recorded; it is not reconstructed from later totals."} Later arrivals/date corrections can change the observed EDD total. Prior-day HFR is excluded from that total.</p>
      <div className="review-operation-table" role="region" aria-label="EDD half-hour history, scroll for all times and columns" tabIndex={0}>
        <table><thead><tr><th>Checkpoint</th><th>Day-start EDD</th><th>Observed EDD</th><th>On road</th><th>Delivered</th><th>Pending</th><th>Attempted</th><th>Unchecked / other</th><th>Observation</th></tr></thead>
          <tbody>{t.rows.map(row => { const c = row.point?.counts.hasSnapshot ? row.point.counts : null; return <tr key={row.label} className={row.state === "Recorded" ? "" : "review-operation-muted"}>
            <th scope="row">{row.label}</th><td>{count(row.dayStart)}</td><td>{c ? count(c.todayTotal - c.todayHfr) : "—"}</td>
            <td>{count(c?.todayOnRoad)}</td><td>{count(c?.todayDelivered)}</td><td className={c?.todayAtStation ? "review-operation-pending" : ""}>{count(c?.todayAtStation)}</td><td>{count(c?.todayAttempted)}</td>
            <td>{c ? count(c.todayUnverified + c.todayOther) : "—"}</td><td>{row.point ? <>{reviewClock(row.point.observedAt)}<small>{row.state}</small></> : row.state}</td>
          </tr>; })}</tbody></table>
      </div>
      <p className="review-operation-note">“Cleared by” is the first recorded zero-pending observation in the latest uninterrupted clear run, not an exact scan time. Recording runs every 5 minutes. Unchecked TIDs, missing EDD dates, stale sources or capture gaps prevent confirmation. Scroll inside this panel; click the card again to close.</p>
      {t.latest ? <p className="review-operation-note">Latest source: stock {reviewClock(t.latest.backlogAt)} · outcomes {reviewClock(t.latest.performanceAt)} · {count(t.latest.counts.missingDate)} missing EDD dates · {count(t.latest.counts.todayHfr)} prior-day HFR.</p> : null}
    </div>
  </details>;
}

export function PerformanceUtrDisciplineCard({ data, date }: { data: { discipline: UtrDiscipline; error: string | null }; date: string }) {
  const { discipline: d, error } = data;
  return <details className={`performance-fact-card review-operation-card ${d.late || d.notReported ? "late" : ""}`} name="performance-review-fact">
    <summary aria-label="UTR reporting discipline — view staff attendance">
      <span>UTR reporting discipline</span><strong>{error ? "Data unavailable" : d.scheduled ? `${d.onTime}/${d.scheduled} on time` : "No scheduled shifts"}</strong>
      <small>{d.late} late · {d.notReported} not reported{d.noShift ? ` · ${d.noShift} shift missing` : ""}</small>
    </summary>
    <div className="review-operation-popover">
      <header><div><b>UTR reporting · {formatDashboardDate(date)}</b><p>Station People staff · approved shifts and attendance</p></div><span className="review-operation-tag">{d.onTime}/{d.scheduled} on time</span></header>
      {error ? <p role="alert">{error}</p> : null}
      <div className="review-operation-summary"><span>Scheduled <b>{d.scheduled}</b></span><span>On time <b>{d.onTime}</b></span><span>Late <b>{d.late}</b></span><span>Not reported <b>{d.notReported}</b></span></div>
      <div className="review-operation-table review-utr-table" role="region" aria-label="UTR staff attendance, scroll for all people and columns" tabIndex={0}>
        <table><thead><tr><th>Person / role</th><th>Shift</th><th>Reported</th><th>Left</th><th>Worked</th><th>Reporting</th></tr></thead><tbody>
          {d.rows.map(row => <tr key={row.id}><th scope="row">{row.name}<small>{row.role} · {row.code}</small></th><td>{row.shift || "Not linked"}</td><td>{reviewClock(row.inTime)}</td><td>{row.outTime ? reviewClock(row.outTime) : row.inTime ? "Missing out" : "—"}</td><td>{hours(row.workMinutes)}</td><td>{row.status}{row.locationNote ? <small>{row.locationNote}</small> : null}</td></tr>)}
          {!d.rows.length ? <tr><td colSpan={6}>{error ? "Attendance could not be loaded." : "No station People staff found for this date."}</td></tr> : null}
        </tbody></table>
      </div>
      <p className="review-operation-note">On time uses the approved shift’s reporting grace. {d.excluded} leave/off-duty staff are excluded; {d.noShift} without a linked shift are shown separately, never counted as on time. Worked hours come from attendance; an incomplete in/out pair is not shown as zero hours. Physical-location exceptions remain visible.</p>
    </div>
  </details>;
}

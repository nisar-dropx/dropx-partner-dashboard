import { Download } from 'lucide-react';
import { OpsLeaveRefresh } from './ops-leave-refresh';
import { employmentLabel, hasLeavePunch, leaveOutcome, leaveReport, punchTime, unplannedQuery, type UnplannedFilters, type UnplannedWorkspace } from '@/lib/ops-pulse/unplanned-leaves';
import './ops-unplanned-leaves.css';
const dateLabel = (date: string) => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
const distinct = (values: (string | null)[]) => [...new Set(values.filter((s): s is string => Boolean(s)))].sort();
const toneClass = (tone: string) => ['neutral', 'amber', 'blue', 'purple', 'green', 'red'].includes(tone) ? tone : 'neutral';
export function OpsUnplannedLeaves({ initial: data, initialFilters: filters }: { initial: UnplannedWorkspace; initialFilters: UnplannedFilters }) {
  const report = leaveReport(data, filters);
  const updated = filters.view === 'updated';
  const href = (changes: Partial<UnplannedFilters> = {}) => '/attendance/unplanned-leaves?' + unplannedQuery(filters, changes);
  const selectedLocationMissing = filters.location && filters.location !== 'unassigned' && !data.locations.some(l => l.id === filters.location);
  return <div className="oul">
    <header className="oul-intro"><span className="oul-eyebrow">TIME & ATTENDANCE</span><h1>Unplanned Leaves</h1>
      <p>People who have not punched. When a punch arrives, their record moves to Updated.</p></header>
    <section className="oul-summary" aria-label="Unplanned leave summary">
      <article><span>Not punched today</span><strong>{report.summary.today}</strong><small>Past shift start + {data.graceMinutes} min</small></article>
      <article><span>Earlier open cases</span><strong>{report.summary.earlier}</strong><small>Still awaiting follow-up</small></article>
      <article><span>Punched since flagged</span><strong>{report.summary.punched}</strong><small>Moved to Updated in this date range</small></article>
    </section>
    <section className="panel oul-panel">
      <div className="oul-queue-head"><nav aria-label="Unplanned leave views" className="oul-tabs">
        <a href={href({ view: 'open', page: 1 })} aria-current={!updated ? 'page' : undefined}>Not punched <span>{report.summary.open}</span></a>
        <a href={href({ view: 'updated', page: 1 })} aria-current={updated ? 'page' : undefined}>Updated <span>{report.summary.updated}</span></a>
      </nav><OpsLeaveRefresh checkedAt={data.checkedAt} /></div>
      {!data.enabled && <p className="oul-notice">New-case detection is disabled in People. Existing cases remain visible.</p>}
      <form className="oul-filters" method="get" action="/attendance/unplanned-leaves">
        <input type="hidden" name="view" value={filters.view}/>
        <label>From<input className="field" name="from" type="date" defaultValue={filters.from} max={data.today} required/></label>
        <label>To<input className="field" name="to" type="date" defaultValue={filters.to} max={data.today} required/></label>
        <label className="oul-search">Search<input className="field" name="search" placeholder="Name, People ID or phone" defaultValue={filters.search}/></label>
        <label>Region<select className="field" name="region" defaultValue={filters.region}><option value="">All regions</option>{distinct(data.locations.map(l => l.region)).map(x => <option key={x}>{x}</option>)}<option value="unassigned">Unassigned</option></select></label>
        <label>Cluster<select className="field" name="cluster" defaultValue={filters.cluster}><option value="">All clusters</option>{distinct(data.locations.map(l => l.cluster)).map(x => <option key={x}>{x}</option>)}<option value="unassigned">Unassigned</option></select></label>
        <label>Location<select className="field" name="location" defaultValue={filters.location}><option value="">All accessible locations</option>{selectedLocationMissing && <option value={filters.location}>Location unavailable</option>}{data.locations.map(l => <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>)}{data.rows.some(r => !r.location_id) && <option value="unassigned">Unassigned</option>}</select></label>
        <label>Status<select className="field" name="status" defaultValue={filters.status}><option value="">All statuses</option>{data.statuses.filter(s => s.is_active || s.id === filters.status || data.rows.some(r => r.status.id === s.id)).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}<option value="punched">Punched in</option><option value="punch_pending">Punch pending approval</option><option value="excluded">Approved leave / excluded</option></select></label>
        <label>Employment<select className="field" name="employment" defaultValue={filters.employment}><option value="">All employment states</option><option value="active">Active</option><option value="inactive">Inactive profiles</option><option value="suspended">Suspended</option><option value="offboarding">Offboarding</option><option value="offboarded">Offboarded / left</option></select></label>
        <div className="oul-filter-actions"><input type="hidden" name="backlog" value="0"/><label className="oul-toggle"><input type="checkbox" name="backlog" value="1" defaultChecked={filters.backlog}/>Include earlier open cases</label><div><button className="button">Apply filters</button><a className="button secondary" href="/attendance/unplanned-leaves">Reset</a></div></div>
      </form>
      <div className="oul-results-head"><p>{report.rows.length.toLocaleString('en-IN')} records · {updated ? 'Punches, approved leave and closed follow-ups' : 'Approved leave and scheduled days off are excluded'}</p>
        <a className="button secondary" href={'/api/ops-pulse/unplanned-leaves?' + unplannedQuery(filters, { page: 1 }) + '&format=xlsx'}><Download size={14}/>Download Excel</a></div>
      <div className="table-wrap"><table><thead><tr><th>Person</th><th>Location</th><th>Day & shift</th><th>Attendance</th><th>Follow-up</th></tr></thead>
        <tbody>{report.pageRows.map(row => {
          const punched = hasLeavePunch(row), outcome = leaveOutcome(row), automatic = punched || Boolean(row.excluded_at);
          return <tr key={row.id}>
            <td><strong>{row.worker_name}</strong><small>{row.worker_code || '—'} · {row.worker_type === 'employee' ? 'Employee' : 'IC'}</small><small>{row.designation_name || 'Unassigned'} · {row.department_name || 'Unassigned'}</small>
              {row.contact_number && <a className="oul-contact" href={'tel:' + row.contact_number.replace(/[^+\d]/g, '')}>{row.contact_number}</a>}
              <div className="oul-employment"><span className="oul-status tone-neutral">{employmentLabel(row)}</span>{row.last_working_date && <small>Last day {dateLabel(row.last_working_date)}</small>}</div></td>
            <td><strong>{row.location_code || 'Unassigned'}</strong><small>{row.location_name}</small><small>{[row.cluster, row.region].filter(Boolean).join(' · ')}</small></td>
            <td><strong>{dateLabel(row.attendance_date)}</strong><small>{row.shift_label || 'Shift not available'}</small></td>
            <td>{punched ? <><span className={'oul-status tone-' + toneClass(outcome.tone)}>{outcome.label}</span><small>First punch <b>{punchTime(row.first_punch_at, row.attendance_date)}</b></small><small>Latest punch <b>{punchTime(row.last_punch_at, row.attendance_date)}</b></small><small>{row.check_out_at ? `Check-out ${punchTime(row.check_out_at, row.attendance_date)}` : 'Check-out not recorded'}</small></>
              : automatic ? <span className="oul-status tone-neutral">{outcome.label}</span> : <><span className="oul-status tone-amber">Not punched</span><small>No punch recorded for this day</small></>}</td>
            <td>{automatic ? <small>Moved automatically</small> : <span className={'oul-status tone-' + toneClass(outcome.tone)}>{outcome.label}</span>}{row.reason && <p className="oul-reason">{row.reason}</p>}{row.last_hr_update_at && <small>Saved {punchTime(row.last_hr_update_at, row.attendance_date)}</small>}</td>
          </tr>;
        })}{!report.rows.length && <tr><td colSpan={5} className="oul-empty"><strong>{updated ? 'No updated cases in this view.' : 'No pending cases match these filters.'}</strong><small>Check the date range or reset your filters.</small></td></tr>}</tbody></table></div>
      <div className="oul-pagination"><span>Showing {report.rows.length ? (report.page - 1) * 50 + 1 : 0}–{Math.min(report.page * 50, report.rows.length)} of {report.rows.length}</span><nav aria-label="Result pages">
        {report.page > 1 ? <a href={href({ page: report.page - 1 })}>Previous</a> : <span aria-disabled="true">Previous</span>}<span>Page {report.page} of {report.pageCount}</span>{report.page < report.pageCount ? <a href={href({ page: report.page + 1 })}>Next</a> : <span aria-disabled="true">Next</span>}
      </nav></div>
    </section>
  </div>;
}

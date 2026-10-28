'use client';
import { useState } from 'react';
import { filterRecoveryUpdates, totalRecoveryUpdates, type RecoveryUpdate } from '@/lib/ops-pulse/loss-recovery-updates';
import { RECOVERY_QUEUE_LABELS } from '@/lib/ops-pulse/loss-recovery-queue-policy';
import { formatOpsDate } from '@/lib/ops-pulse/date-format';
import { monthLabel } from '@/lib/ops-pulse/nl-loss-policy';
import { ListPager, usePaged } from './list-pager';
import styles from './nl-loss.module.css';

const money = (value: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value);
export function LossRecoveryUpdates({ rows }: { rows: RecoveryUpdate[] }) {
  const [station, setStation] = useState(''), [month, setMonth] = useState(''), [status, setStatus] = useState(''), [query, setQuery] = useState('');
  const shown = filterRecoveryUpdates(rows, { station, month, status, query });
  const totals = totalRecoveryUpdates(shown);
  const paged = usePaged(shown, 25, `${station}|${month}|${status}|${query}`);
  const groups = [...new Set(shown.map(row => row.station))].sort().map(code => ({ code, ...totalRecoveryUpdates(shown.filter(row => row.station === code)) }));
  return <>
    <section className={styles.panel}>
      <div className={styles.toolbar} style={{ padding: 12, flexWrap: 'wrap' }}>
        <label>Station<select value={station} onChange={event => setStation(event.target.value)}><option value="">All stations</option>{[...new Set(rows.map(row => row.station))].sort().map(code => <option key={code}>{code}</option>)}</select></label>
        <label>Loss month<select value={month} onChange={event => setMonth(event.target.value)}><option value="">All months · till date</option>{[...new Set(rows.map(row => row.month))].sort().reverse().map(value => <option key={value} value={value}>{monthLabel(value)}</option>)}</select></label>
        <label>Recovery status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All saved updates</option>{[...new Set(rows.map(row => row.status))].sort().map(value => <option key={value} value={value}>{RECOVERY_QUEUE_LABELS[value] || value}</option>)}</select></label>
        <label>Search<input placeholder="TID, person or station" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <a className={styles.button} href="/team-ops/losses/recovery-updates">Pending recovery updates →</a>
      </div>
    </section>
    <div className={`${styles.metrics} ${styles.metrics4}`}>
      <div><span>Saved recovery TIDs</span><strong>{totals.count.toLocaleString('en-IN')}</strong><small>{money(totals.amount)} loss value · {totals.people} assigned people</small></div>
      <div><span>Pending collection</span><strong>{money(totals.outstanding)}</strong><small>Includes {money(totals.draft)} in draft payroll</small></div>
      <div><span>Recovered</span><strong>{money(totals.collected)}</strong><small>Confirmed payroll and verified receipts</small></div>
      <div><span>Awaiting approval / review</span><strong>{totals.review.toLocaleString('en-IN')}</strong><small>Saved updates requiring attention</small></div>
    </div>
    <section className={styles.panel}>
      <div className={styles.panelHead}><div><h2>Station recovery updates</h2><small>Saved final-case updates across all loss months. Saving a plan does not mean the money has been collected.</small></div></div>
      <div className={styles.tableWrap}><table><thead><tr><th>Station</th><th>TIDs / people</th><th>Loss value</th><th>Assigned</th><th>Recovered</th><th>Pending collection</th><th>Draft payroll</th><th>Last update</th></tr></thead>
        <tbody>{groups.map(group => <tr key={group.code}><td><button className={styles.button} onClick={() => setStation(group.code)}>{group.code}</button></td><td>{group.count} / {group.people}</td><td>{money(group.amount)}</td><td>{money(group.assigned)}</td><td>{money(group.collected)}</td><td>{money(group.outstanding)}</td><td>{money(group.draft)}</td><td>{group.updatedAt ? formatOpsDate(group.updatedAt) : '—'}</td></tr>)}</tbody></table></div>
      {!shown.length ? <p className={styles.empty}>No saved recovery updates match this selection. Open Pending recovery updates to assign final cases.</p> : null}
    </section>
    {shown.length ? <section className={styles.panel}>
      <div className={styles.panelHead}><h2>Updated shipments · {shown.length}</h2>{station ? <button className={styles.button} onClick={() => setStation('')}>All stations</button> : null}</div>
      <div className={styles.tableWrap}><table><thead><tr><th>Shipment / loss month</th><th>People / outcome</th><th>Status</th><th>Loss value</th><th>Recovered</th><th>Pending collection</th><th>Updated</th></tr></thead><tbody>
        {paged.rows.map(row => <tr key={row.key}>
          <td><a href={`/team-ops/losses/recovery-updates?case=${encodeURIComponent(row.caseKey)}&month=${encodeURIComponent(row.month)}`}>{row.tid}</a><small>{row.station} · {row.report.toUpperCase()} · {monthLabel(row.month)}</small></td>
          <td>{row.people.length ? row.people.map(person => person.name || person.code).join(', ') : 'No payroll allocation'}<small>{row.outcome}</small></td>
          <td>{RECOVERY_QUEUE_LABELS[row.status] || row.status}<small>{row.payrollMonth && row.outstanding > 0 ? `Scheduled from ${monthLabel(row.payrollMonth)}` : ''}</small></td>
          <td>{money(row.amount)}</td><td>{money(row.collected)}</td><td>{money(row.outstanding)}{row.waived > 0 ? <small>{money(row.waived)} written off</small> : null}</td>
          <td>{row.updatedAt ? formatOpsDate(row.updatedAt) : '—'}<small>{row.updatedBy}</small></td>
        </tr>)}
      </tbody></table></div>
      <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="shipments"/>
    </section> : null}
  </>;
}

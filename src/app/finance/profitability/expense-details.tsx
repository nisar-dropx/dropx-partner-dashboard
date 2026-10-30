'use client';
import type { CfoLine } from '@/lib/finance/cfo';
import type { PnlEvidence } from '@/lib/finance/pnl-evidence';
import { groupCostLines, paise } from '@/lib/finance/pnl-cost-heads';

const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CostSourceGroups({ lines, evidence, flattenSingle = false }: { lines: CfoLine[]; evidence?: PnlEvidence; flattenSingle?: boolean }) {
  const groups = groupCostLines(lines);
  return <div className="pnl-calculation-list">{groups.map(group => {
    const dates = new Set(group.entries.map(l => l.date));
    const rentals = group.source === 'Fleet Vehicle Master'
      ? (evidence?.vehicles || []).filter(v => v.station_code === group.station && group.label === `Vehicle rent · ${v.vehicle_no}`) : [];
    const vehicle = rentals.length && rentals.every(v => v.daily_rent === rentals[0].daily_rent && v.monthly_rent === rentals[0].monthly_rent)
      && (rentals[0].daily_rent != null || rentals[0].monthly_rent != null) ? rentals[0] : undefined;
    const provider = group.label.toUpperCase().includes('BPCL') ? 'BPCL' : group.label.toUpperCase().includes('IOC') ? 'IOC' : '';
    const fuel = group.source === 'Fuel import' && provider ? (evidence?.fuel || []).filter(f =>
      f.station_code === group.station && dates.has(f.transaction_date) && f.provider.toUpperCase().startsWith(provider)) : [];
    // Transaction detail replaces the daily list only when it reconciles with the report.
    const matchedFuel = fuel.length > 0 && fuel.reduce((s, f) => s + paise(Number(f.amount)), 0) === paise(group.amount);
    const body = <div className="pnl-calculation-body">
        {vehicle && <p className="pnl-formula">{vehicle.model} · {vehicle.daily_rent != null ? `${money(vehicle.daily_rent)} per eligible day` : `${money(vehicle.monthly_rent || 0)} per month, prorated by calendar days`}. Dates and rent-blocked days are shown below.</p>}
        <div className="pnl-scroll pnl-calculation-table"><table><thead><tr>
          <th>Date</th>{matchedFuel ? <><th>Vehicle</th><th>Reference</th><th>Litres</th></> : <th>Cost detail</th>}<th>Amount</th>
        </tr></thead><tbody>{matchedFuel ? fuel.map(f => <tr key={f.id}><td>{f.transaction_date}</td><td>{f.vehicle_no || 'Unspecified'}</td><td>{f.provider} · {f.transaction_id}</td><td>{f.litres}</td><td>{money(Number(f.amount))}</td></tr>)
          : group.entries.map((l, i) => <tr key={i}><td>{l.date}</td><td>{l.head}{group.source === 'Fleet Vehicle Master' && l.amount === 0 ? ' · rent blocked' : ''}</td><td>{money(l.amount)}</td></tr>)}</tbody></table></div>
      </div>;
    if (flattenSingle && groups.length === 1) return <div key={group.key}><p className="pnl-footnote">{group.label} · {group.station} · {group.source}</p>{body}</div>;
    return <details className="pnl-calculation-record" key={group.key}>
      <summary><span>{group.label}<small>{group.station} · {group.source} · {dates.size} {dates.size === 1 ? 'day' : 'days'}</small></span><strong>{money(group.amount)}</strong></summary>
      {body}
    </details>;
  })}</div>;
}

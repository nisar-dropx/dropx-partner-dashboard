import type { CpsFacilityRent } from "@/lib/ops-pulse/cps";

const money = (value: number) => `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function CpsRentDetails({ rows }: { rows: CpsFacilityRent[] }) {
  if (!rows.length) return <p className="cps-footnote">Monthly rate details are unavailable. The accrued rent above remains included.</p>;
  return <div className="cps-rent-details">
    {rows.map((row, i) => <article key={`${row.id}|${row.from_date}|${i}`}>
      <header><strong>{row.site_code || row.station_code}</strong><span>{row.from_date} – {row.through_date}</span></header>
      {row.site_code !== row.station_code && <p>Allocated to {row.station_code}</p>}
      <dl>
        <div><dt>Actual monthly rent</dt><dd>{money(row.monthly_rent)}</dd></div>
        <div><dt>Monthly maintenance</dt><dd>{money(row.monthly_maintenance)}</dd></div>
        <div><dt>Days charged / calendar days</dt><dd>{row.days} / {row.calendar_days}</dd></div>
        <div><dt>Cost for these dates</dt><dd>{money(row.amount)}</dd></div>
      </dl>
      <p className="cps-rent-formula">{money(row.monthly_rent + row.monthly_maintenance)} monthly total ÷ {row.calendar_days} calendar days × {row.days} charged days = <strong>{money(row.amount)}</strong></p>
    </article>)}
    <p className="cps-footnote">Rates come from Finance Rent Master. Each month and effective rate is shown separately; daily rounding can differ by a few paise.</p>
  </div>;
}

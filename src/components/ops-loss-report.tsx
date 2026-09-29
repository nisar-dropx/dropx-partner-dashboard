import styles from "@/components/workforce-hold-desk.module.css";
import type { LossReportView } from "@/lib/ops-pulse/loss-reports";

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
const time = (value: string | null) => value ? `${new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : "—";
/** Keep wide Amazon files readable: identity columns first, at most 12 columns in the detail table. */
const MAX_COLUMNS = 12;

export function OpsLossReport({ title, intro, basePath, query = {}, view, tabs }: {
  title: string;
  intro: string;
  basePath: string;
  query?: Record<string, string>;
  view: LossReportView;
  tabs?: React.ReactNode;
}) {
  const { run, totals, rows, selectedStation } = view;
  const hasAmount = Boolean(run?.amount_column);
  const totalRows = totals.reduce((s, t) => s + t.row_count, 0);
  const totalAmount = totals.reduce((s, t) => s + t.total_amount, 0);
  const href = (station?: string) => {
    const params = new URLSearchParams(query);
    if (station) params.set("station", station);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const columns = run ? [
    ...[run.reference_column, run.station_column, run.amount_column].filter((c): c is string => Boolean(c)),
    ...run.headers.filter((h) => h !== run.reference_column && h !== run.station_column && h !== run.amount_column)
  ].slice(0, MAX_COLUMNS) : [];

  return <div className={styles.desk}>
    <section className="panel">
      <header className="panel-head"><div>
        <h1>{title}</h1>
        <p>{intro}</p>
        {run ? <p>
          Source: {run.source_file ?? "Amazon report"}{run.period_label ? ` · Period ${run.period_label}` : ""}{run.source_week ? ` · ${run.source_week}` : ""}
          <br />Last updated {time(run.finished_at)}{run.source_created_at ? ` · Amazon published ${run.source_created_at}` : ""}
          {view.scopedToAll ? null : <><br />Showing only the stations you have access to.</>}
        </p> : null}
      </div></header>
      {tabs}
      {view.lastFailure ? <p role="status">The latest refresh failed ({time(view.lastFailure.finished_at)}). Showing the last successful pull. {view.lastFailure.error}</p> : null}
      {!run ? <p role="status" style={{ padding: 20 }}>No report has been pulled yet. It appears here automatically after the loss worker's next run.</p> : null}
      {run ? <div className="table-wrap"><table>
        <thead><tr><th>Station</th><th>Cases</th>{hasAmount ? <th>Loss amount</th> : null}<th></th></tr></thead>
        <tbody>
          {totals.map((t) => <tr key={t.station_code} aria-current={t.station_code === selectedStation ? "true" : undefined}>
            <td><strong>{t.station_code}</strong>{t.station_name ? <><br />{t.station_name}</> : null}</td>
            <td>{t.row_count.toLocaleString("en-IN")}</td>
            {hasAmount ? <td>{money(t.total_amount)}</td> : null}
            <td><a className="button secondary" href={href(t.station_code)}>View cases</a></td>
          </tr>)}
          {!totals.length ? <tr><td colSpan={hasAmount ? 4 : 3}>No losses for your stations in this report.</td></tr> : null}
        </tbody>
        {totals.length > 1 ? <tfoot><tr><th>Total</th><th>{totalRows.toLocaleString("en-IN")}</th>{hasAmount ? <th>{money(totalAmount)}</th> : null}<th></th></tr></tfoot> : null}
      </table></div> : null}
    </section>

    {run && selectedStation ? <section className="panel">
      <header className="panel-head"><h2>{selectedStation} · {rows.length.toLocaleString("en-IN")} cases</h2><a className="button secondary" href={href()}>Close</a></header>
      <div className="table-wrap"><table>
        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id}>{columns.map((c) => <td key={c}>{r.raw[c] ?? ""}</td>)}</tr>)}
          {!rows.length ? <tr><td colSpan={Math.max(columns.length, 1)}>No cases.</td></tr> : null}
        </tbody>
      </table></div>
    </section> : null}
  </div>;
}

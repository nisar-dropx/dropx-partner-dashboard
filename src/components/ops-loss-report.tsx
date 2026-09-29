import Link from "next/link";
import styles from "@/components/ops-loss-report.module.css";
import { OpsLossCases } from "@/components/ops-loss-cases";
import type { LossReportView } from "@/lib/ops-pulse/loss-reports";

export type LossTab = { key: string; label: string; href: string };

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
const time = (value: string | null) => value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";

export function LossTabs({ tabs, active }: { tabs: LossTab[]; active: string }) {
  return <nav className={styles.tabs} aria-label="Loss reports">
    {tabs.map((t) => <Link key={t.key} href={t.href} prefetch className={`${styles.tab} ${t.key === active ? styles.activeTab : ""}`} aria-current={t.key === active ? "page" : undefined}>{t.label}</Link>)}
  </nav>;
}

export function OpsLossReport({ title, intro, basePath, view, tabs, activeTab }: {
  title: string;
  intro: string;
  basePath: string;
  view: LossReportView;
  tabs: LossTab[];
  activeTab: string;
}) {
  const { run, totals, rows, selectedStation } = view;
  const hasAmount = Boolean(run?.amount_column);
  const totalRows = totals.reduce((s, t) => s + t.row_count, 0);
  const totalAmount = totals.reduce((s, t) => s + t.total_amount, 0);
  const top = totals[0];
  const maxShare = hasAmount ? Math.max(...totals.map((t) => t.total_amount), 1) : Math.max(...totals.map((t) => t.row_count), 1);
  const selected = totals.find((t) => t.station_code === selectedStation);

  return <div className={styles.workspace}>
    <header className={styles.header}>
      <div>
        <span className={styles.eyebrow}>Team Ops · Losses</span>
        <h1>{title}</h1>
        <p>{intro}</p>
      </div>
      <LossTabs tabs={tabs} active={activeTab} />
    </header>

    {run ? <div className={styles.context}>
      <span>Source <strong>{(run.source_file ?? "Amazon report").trim()}</strong></span>
      {run.period_label ? <><i className={styles.dot} /><span>Period <strong>{run.period_label}</strong></span></> : null}
      {run.source_week ? <><i className={styles.dot} /><span>{run.source_week}</span></> : null}
      <i className={styles.dot} /><span>Data changed <strong>{time(run.finished_at)}</strong></span>
      {run.checked_at && run.checked_at !== run.finished_at ? <><i className={styles.dot} /><span>Last checked <strong>{time(run.checked_at)}</strong></span></> : null}
      {view.scopedToAll ? null : <><i className={styles.dot} /><span>Your stations only</span></>}
    </div> : null}

    {view.lastFailure ? <div className={styles.notice} role="status">
      <strong>The latest refresh didn&apos;t complete ({time(view.lastFailure.finished_at)}).</strong> {run ? "Showing the last successful pull." : "This page fills in on the next successful pull."}
      <details><summary>Technical details</summary><code>{view.lastFailure.error}</code></details>
    </div> : null}

    {!run ? <section className={styles.panel}><div className={styles.empty}><strong>No report pulled yet</strong>It appears here automatically after the loss worker&apos;s next successful run.</div></section> : <>
      <div className={styles.metrics}>
        {hasAmount ? <div className={`${styles.metric} ${styles.orange}`}><span>Total loss</span><strong>{money(totalAmount)}</strong><small>across your stations</small></div> : null}
        <div className={`${styles.metric} ${styles.blue}`}><span>Cases</span><strong>{totalRows.toLocaleString("en-IN")}</strong><small>{run.total_rows.toLocaleString("en-IN")} in the full file</small></div>
        <div className={`${styles.metric} ${styles.purple}`}><span>Stations affected</span><strong>{totals.length}</strong><small>with at least one case</small></div>
        <div className={`${styles.metric} ${styles.green}`}><span>Highest station</span><strong>{top ? top.station_code : "—"}</strong><small>{top ? (hasAmount ? money(top.total_amount) : `${top.row_count} cases`) : "no cases"}</small></div>
      </div>

      <section className={styles.panel}>
        <div className={styles.panelHead}><div><h2>Station-wise losses</h2><p>Select a station to see its cases.</p></div></div>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>Station</th><th className={styles.numeric}>Cases</th>{hasAmount ? <th className={styles.numeric}>Loss amount</th> : null}<th>Share</th><th /></tr></thead>
          <tbody>
            {totals.map((t) => {
              const value = hasAmount ? t.total_amount : t.row_count;
              const pct = hasAmount ? (totalAmount ? t.total_amount / totalAmount : 0) : (totalRows ? t.row_count / totalRows : 0);
              const isSelected = t.station_code === selectedStation;
              return <tr key={t.station_code} className={isSelected ? styles.selectedRow : undefined}>
                <td className={styles.station}><strong>{t.station_code}</strong>{t.station_name ? <small>{t.station_name}</small> : null}</td>
                <td className={styles.numeric}>{t.row_count.toLocaleString("en-IN")}</td>
                {hasAmount ? <td className={styles.numeric}><strong>{money(t.total_amount)}</strong></td> : null}
                <td><div className={styles.share}><div className={styles.bar}><span style={{ width: `${Math.max(3, (value / maxShare) * 100)}%` }} /></div><em>{(pct * 100).toFixed(1)}%</em></div></td>
                <td className={styles.numeric}>{isSelected
                  ? <Link href={basePath} scroll={false} className={styles.button}>Hide cases</Link>
                  : <Link href={`${basePath}?station=${encodeURIComponent(t.station_code)}`} scroll={false} className={`${styles.button} ${styles.primary}`}>View cases</Link>}</td>
              </tr>;
            })}
            {!totals.length ? <tr><td colSpan={hasAmount ? 5 : 4}><div className={styles.empty}><strong>No losses for your stations</strong>Nothing in this report is mapped to a station you can access.</div></td></tr> : null}
          </tbody>
          {totals.length > 1 ? <tfoot><tr><td>Total</td><td className={styles.numeric}>{totalRows.toLocaleString("en-IN")}</td>{hasAmount ? <td className={styles.numeric}>{money(totalAmount)}</td> : null}<td /><td /></tr></tfoot> : null}
        </table></div>
      </section>

      {selected ? <OpsLossCases
        key={selected.station_code}
        report={activeTab === "nl" ? "nl" : "slp"}
        station={selected.station_code}
        stationName={selected.station_name}
        rows={rows}
        closeHref={basePath}
        fileLabel={`${activeTab}-${selected.station_code}`}
      /> : null}
    </>}
  </div>;
}

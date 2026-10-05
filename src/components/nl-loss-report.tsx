import Link from "next/link";
import { NlLossRefresh } from "./nl-loss-refresh";
import { LossTabs, type LossTab } from "@/components/ops-loss-report";
import { NlLossCases } from "./nl-loss-cases";
import type { NlView } from "@/lib/ops-pulse/nl-loss";
import { monthLabel } from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
const time = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not checked";
export function NlLossReport({
  view: v,
  tabs,
}: {
  view: NlView;
  tabs: LossTab[];
}) {
  const href = (station: string) => {
    const q = new URLSearchParams();
    if (v.month) q.set("month", v.month);
    if (v.cluster) q.set("cluster", v.cluster);
    if (v.reason) q.set("reason", v.reason);
    if (station) q.set("station", station);
    return "/attendance/losses/nl?" + q;
  };
  return (
    <main className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Team Ops · Monthly recovery</span>
          <h1>NL loss</h1>
          <p>
            Final recoverable cases from Cloak. Review the loss, then record the
            station recovery plan.
          </p>
        </div>
        <LossTabs tabs={tabs} active="nl" />
      </header>
      <div className={styles.context}>
        <span>Latest check: {time(v.checked)}</span>
        {v.canRefresh ? <NlLossRefresh /> : null}
        {v.canMaster ? (
          <Link href="/master/loss-recovery">Loss Recovery Master ↗</Link>
        ) : null}
      </div>
      {v.failure ? (
        <div className={styles.notice} role="status">
          The latest Cloak refresh did not complete (
          {time(v.failure.finished_at)}). Showing the last successful data.
          <details>
            <summary>Refresh details</summary>
            {v.failure.error}
          </details>
        </div>
      ) : null}
      <form className={styles.filters} action="/attendance/losses/nl">
        <label>
          Recovery month
          <select name="month" defaultValue={v.month ?? ""} key={v.month}>
            {v.months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cluster
          <select name="cluster" defaultValue={v.cluster} key={v.cluster}>
            <option value="">All my clusters</option>
            {v.clusterOptions.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Station
          <select name="station" defaultValue={v.station} key={v.station}>
            <option value="">All my stations</option>
            {v.stations.map((s) => (
              <option key={s.id} value={s.source_code}>
                {s.station_code} · {s.station_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Loss reason
          <select name="reason" defaultValue={v.reason} key={v.reason}>
            <option value="">All reasons</option>
            {v.reasons.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <button className={styles.primary}>Apply filters</button>
        <Link href="/attendance/losses/nl" className={styles.button}>
          Reset
        </Link>
      </form>
      <div className={styles.monthLine}>
        <h2>{v.month ? monthLabel(v.month) : "No recovery month available"}</h2>
        <span>Recoverable only · Source refreshed {time(v.monthLastSeen)}</span>
      </div>
      <div className={styles.metrics}>
        <div>
          <span>Recoverable loss</span>
          <strong>{money(v.totals.reduce((a, b) => a + b.amount, 0))}</strong>
          <small>Amazon’s final recoverable value</small>
        </div>
        <div>
          <span>Cases</span>
          <strong>
            {v.totals.reduce((a, b) => a + b.count, 0).toLocaleString("en-IN")}
          </strong>
          <small>For this month and selected filters</small>
        </div>
        <div>
          <span>Stations</span>
          <strong>{v.totals.length}</strong>
          <small>Within your authorized locations</small>
        </div>
      </div>
      {v.station ? (
        <div className={styles.context}>
          <Link href={href("")}>← All station totals</Link>
          <span>Station {v.station}</span>
        </div>
      ) : (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Station recovery overview</h2>
            <span>Select a station to review its cases</span>
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Station</th>
                  <th>Cluster</th>
                  <th>Cases</th>
                  <th>Recoverable value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {v.totals.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.station_code}</strong>
                      <small>{s.station_name}</small>
                    </td>
                    <td>{s.cluster}</td>
                    <td>{s.count}</td>
                    <td>
                      <strong>{money(s.amount)}</strong>
                    </td>
                    <td>
                      <Link
                        className={styles.button}
                        href={href(s.source_code)}
                      >
                        Review cases →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!v.totals.length ? (
            <p className={styles.empty}>
              No recoverable cases match these filters.
            </p>
          ) : null}
        </section>
      )}
      {v.station ? (
        <NlLossCases
          key={[v.month, v.station, v.reason].join(":")}
          cases={v.cases}
          outcomes={v.outcomes}
          settings={v.settings}
          canEdit={v.canEdit}
        />
      ) : null}
      <p className={styles.footer}>
        Months are retained separately as Cloak publishes them. A recovery plan
        records responsibility and follow-up; it does not deduct money from
        payroll.
      </p>
    </main>
  );
}

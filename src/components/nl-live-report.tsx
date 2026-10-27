import { LossFinalMetrics } from "./loss-final-metrics";
import { LossWorkbook } from "./loss-workbook";
import { LossMultiFilter, LossTableSort } from "./loss-list-controls";
import { lossFilterValues } from "@/lib/ops-pulse/loss-list-controls";
import Link from "next/link";
import type { LossTab } from "@/components/ops-loss-report";
import { LossHeader, LOSSES_PATH, NlViewSwitch } from "./nl-loss-report";
import { NlLiveCases } from "./nl-live-cases";
import { monthLabel } from "@/lib/ops-pulse/nl-loss-policy";
import {
  STAGE_COPY,
  WINDOW_STAGES,
  daysUntil,
} from "@/lib/ops-pulse/nl-dispute-policy";
import type { NlLiveView } from "@/lib/ops-pulse/nl-live";
import { formatOpsDate, formatOpsDateTime } from "@/lib/ops-pulse/date-format";
import styles from "./nl-loss.module.css";

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
const day = (date: string) => formatOpsDate(date);
const time = (s: string | null) => (s ? formatOpsDateTime(s) : "Not checked");
const left = (days: number) =>
  days < 0
    ? "Closed"
    : days === 0
      ? "Closes today"
      : days === 1
        ? "Closes tomorrow"
        : `${days} days left`;

/** The month Cloak is still deciding: where the window stands, and what each station still owes. */
export function NlLiveReport({
  view: v,
  tabs,
}: {
  view: NlLiveView;
  tabs: LossTab[];
}) {
  const isFinal = v.stageView === "final";
  const viewKey = isFinal ? "historic" : "live";
  const base = `${LOSSES_PATH}/nl`;
  const href = (next: { station?: string; phase?: string }) => {
    const q = new URLSearchParams({ view: viewKey });
    if (v.month && v.month !== v.months[0]) q.set("month", v.month);
    if (v.cluster) q.set("cluster", v.cluster);
    if (v.reason) q.set("reason", v.reason);
    if (v.sort) q.set("sort", v.sort);
    const station = next.station ?? v.station;
    if (station) q.set("station", station);
    const phase = next.phase ?? v.phase;
    if (phase) q.set("phase", phase);
    return `${base}?${q}`;
  };
  const s = v.summary;
  const current = v.stage.stage;
  const stationOwes = current === "eDSP1" || current === "eDSP2";
  return (
    <main className={styles.workspace}>
      <LossHeader
        eyebrow="Team Ops · Losses"
        title="NL loss"
        intro={isFinal ? "Confirmed outcomes. Assign recovery for recoverable cases." : "Pending decisions. Dispute or respond within the source window."}
        tabs={tabs}
        active="nl"
      />
      <NlViewSwitch active={viewKey} />
      {isFinal?<p className={styles.hint}><Link href="/team-ops/losses/recovery-updates">Pending recovery updates → all loss months</Link></p>:null}
      {!v.ready ? (
        <div className={styles.notice} role="status">
          The live dispute view is being enabled. Recovery for closed months
          is available under Historic.
        </div>
      ) : !v.month ? (
        <section className={styles.panel}>
          <p className={styles.empty}>
            No cases in this section for your stations. Check the other section for pending or final cases.
          </p>
        </section>
      ) : (
        <>
          {!isFinal ? <details className={styles.compactDetails}><summary>Dispute dates · {monthLabel(v.month)}</summary><section className={styles.window} aria-label="Dispute window">
            <div className={styles.windowHead}>
              <div>
                <h2>{monthLabel(v.month)} losses</h2>
                <span>
                  Cloak checked {time(v.checked)}
                  {v.months.length > 1
                    ? ` · ${v.months.length} open months`
                    : ""}
                </span>
              </div>
              {current && current !== "Completed" && v.stage.deadline ? (
                <div
                  className={`${styles.countdown} ${stationOwes ? ((v.stage.daysLeft ?? 9) <= 2 ? styles.bad : styles.warn) : styles.info}`}
                >
                  <strong>{left(v.stage.daysLeft ?? 0)}</strong>
                  <span>
                    {STAGE_COPY[current].title} · until {day(v.stage.deadline)}
                  </span>
                </div>
              ) : current === "Completed" ? (
                <div className={`${styles.countdown} ${styles.muted}`}>
                  <strong>Reviews complete</strong>
                  <span>Confirmed cases appear in Final</span>
                </div>
              ) : (
                <div className={`${styles.countdown} ${styles.muted}`}>
                  <strong>Deadlines pending</strong>
                  <span>Cloak has not published this month’s dates yet</span>
                </div>
              )}
            </div>
            <ol className={styles.timeline}>
              {WINDOW_STAGES.map((stage) => {
                const date = v.window[stage];
                const state =
                  current === stage
                    ? "now"
                    : date && daysUntil(date) < 0
                      ? "past"
                      : "next";
                return (
                  <li key={stage} data-state={state}>
                    <i aria-hidden />
                    <div>
                      <strong>{STAGE_COPY[stage].title}</strong>
                      <span>
                        {STAGE_COPY[stage].owner === "station"
                          ? "Stations"
                          : "Amazon"}{" "}
                        · {date ? `until ${day(date)}` : "date pending"}
                      </span>
                      <small>{STAGE_COPY[stage].detail}</small>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
          </details> : null}
          <div className={`${styles.metrics} ${styles.metrics4}`}>
            {!isFinal ? <>
            <div>
              <span>Waiting on stations</span>
              <strong>{s.pending.toLocaleString("en-IN")}</strong>
              <small>
                {money(s.pendingAmount)} ·{" "}
                {s.unsent
                  ? `${s.unsent.toLocaleString("en-IN")} not yet sent to the Cloak desk`
                  : "all sent to the Cloak desk"}
              </small>
            </div>
            <div>
              <span>With Amazon</span>
              <strong>{s.withAmazon.toLocaleString("en-IN")}</strong>
              <small>{money(s.withAmazonAmount)} under review</small>
            </div>
            </> : null}
          </div>
          {isFinal ? <><LossFinalMetrics summary={s}/><p className={styles.hint}>Updated means recovery details saved; deductions appear in Recovery by payroll month.</p></> : null}
          {!isFinal && v.canDesk && v.deskQueue ? (
            <div className={styles.workbook}>
              <div>
                <strong>
                  Cloak desk · {v.deskQueue} request
                  {v.deskQueue === 1 ? "" : "s"} to file
                </strong>
                <span>
                  Stations have sent these for filing. Open a case to file its
                  first dispute in Cloak from here. Accepted losses and
                  responses to Amazon are filed in Cloak by hand — download the
                  queue; they are marked filed on the next hourly check.
                </span>
              </div>
              <a
                className={styles.button}
                href={`/api/ops-pulse/losses/disputes/queue?month=${v.month}`}
              >
                Download filing queue
              </a>
            </div>
          ) : null}
          <form className={styles.filters} action={base}>
            <input type="hidden" name="view" value={viewKey} />
            {v.months.length > 1 ? (
              <label>
                Loss month
                <select name="month" defaultValue={v.month} key={v.month}>
                  {v.months.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <LossMultiFilter key={`cluster:${v.cluster}`} name="cluster" label="Cluster / AOM" value={v.cluster} options={v.clusterOptions} allLabel="All my clusters" />
            <LossMultiFilter key={`station:${v.station}`} name="station" label="Station" value={v.station} options={v.stations.map(s => ({ value: s.source_code, label: `${s.station_code} · ${s.station_name}` }))} allLabel="All my stations" />
            <LossMultiFilter key={`reason:${v.reason}`} name="reason" label="Loss reason" value={v.reason} options={v.reasons.map(r => ({ value: r, label: r }))} allLabel="All reasons" />
            <button className={styles.primary}>Apply filters</button>
            <Link href={`${base}?view=${viewKey}`} className={styles.button}>
              Reset
            </Link>
          </form>
          {isFinal && v.totals.length ? <details className={styles.compactDetails}><summary>Bulk recovery update</summary><LossWorkbook kind="nl" query={new URLSearchParams({ kind: "nl", month: v.month, station: v.station || "", cluster: v.cluster || "", reason: v.reason || "" }).toString()} canUpload={v.canDispute} scope={v.station ? `stations ${v.station}` : "your stations"} /></details> : null}
          {v.station ? (
            <>
              <div className={styles.context}>
                <Link href={href({ station: "", phase: "" })}>
                  ← All station totals
                </Link>
                <span>Stations {lossFilterValues(v.station).join(", ")}</span>
              </div>
              <NlLiveCases
                key={[viewKey, v.month, v.station, v.reason].join(":")}
                stageView={isFinal ? "final" : "initial"}
                month={v.month}
                cases={v.cases}
                window={v.window}
                initialPhase={v.phase}
                canDispute={v.canDispute}
                canDesk={v.canDesk}
                canApprove={v.canApprove}
                outcomes={v.outcomes}
                settings={v.settings}
                canRecovered={v.canRecovered}
              />
            </>
          ) : (
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2>{isFinal ? "Station recovery updates" : "Station dispute overview"}</h2>
                <LossTableSort value={v.sort} />
              </div>
              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Current cluster · People</th>
                      <th>{isFinal ? "Total shipments / value" : "Raised"}</th>
                      {!isFinal ? <><th>Waiting on station</th><th>With Amazon</th></> : null}
                      {isFinal ? <><th>Updated / value</th><th>Pending / value</th><th>Non-recoverable</th></> : <><th>Saved</th><th>Recoverable</th></>}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {v.totals.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.station_code}</strong>
                          <small>{t.station_name}</small>
                        </td>
                        <td>{t.cluster}</td>
                        <td>
                          {t.count}
                          <small>{money(t.amount)}</small>
                        </td>
                        {!isFinal ? <>
                        <td>
                          {t.pending ? (
                            <span className={`${styles.badge} ${styles.warn}`}>
                              {t.pending} · {money(t.pendingAmount)}
                            </span>
                          ) : (
                            <span className={`${styles.badge} ${styles.good}`}>
                              None
                            </span>
                          )}
                          {t.pending ? (
                            <small>
                              {t.unsent
                                ? `${t.unsent} not sent to desk`
                                : "all sent to desk"}
                            </small>
                          ) : null}
                        </td>
                        <td>{t.withAmazon}</td>
                        </> : null}
                        {isFinal ? <><td>{t.updated}<small>{money(t.updatedAmount)}</small></td><td>{t.pendingUpdate}<small>{money(t.pendingUpdateAmount)}</small></td><td>{t.nonrecoverable}<small>{money(t.nonrecoverableAmount)}</small></td></> : <><td>{t.saved ? money(t.savedAmount) : "—"}</td><td>{t.recoverable ? money(t.recoverableAmount) : "—"}</td></>}
                        <td>
                          <Link
                            className={t.pending ? styles.primary : styles.button}
                            href={href({
                              station: t.source_code,
                              phase: t.pending ? "todo" : "",
                            })}
                          >
                            {t.pending ? "Review & dispute →" : "View cases →"}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!v.totals.length ? (
                <p className={styles.empty}>
                  No live cases match these filters.
                </p>
              ) : null}
            </section>
          )}
          <p className={styles.footer}>
            Cases refresh from Cloak every hour. Confirmed outcomes appear in Final; pending decisions stay in Initial.
          </p>
        </>
      )}
    </main>
  );
}

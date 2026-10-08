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
import styles from "./nl-loss.module.css";

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const time = (s: string | null) =>
  s
    ? new Date(s).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not checked";
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
  const base = `${LOSSES_PATH}/nl`;
  const href = (next: { station?: string; phase?: string }) => {
    const q = new URLSearchParams({ view: "live" });
    if (v.month && v.month !== v.months[0]) q.set("month", v.month);
    if (v.cluster) q.set("cluster", v.cluster);
    if (v.reason) q.set("reason", v.reason);
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
        eyebrow="Team Ops · Cloak live month"
        title="NL loss"
        intro="Every loss Amazon has raised for the month still in dispute. Dispute or accept each case before the window closes."
        tabs={tabs}
        active="nl"
      />
      <NlViewSwitch active="live" />
      {!v.ready ? (
        <div className={styles.notice} role="status">
          The live dispute view is being enabled. Recovery for closed months
          is available under Historic.
        </div>
      ) : !v.month ? (
        <section className={styles.panel}>
          <p className={styles.empty}>
            Cloak has no open month for your stations right now. A new month
            appears around the 4th; closed months are under Historic.
          </p>
        </section>
      ) : (
        <>
          <section className={styles.window} aria-label="Dispute window">
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
                  <span>This month moves to Historic next</span>
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
          <div className={`${styles.metrics} ${styles.metrics4}`}>
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
            <div>
              <span>Saved by dispute</span>
              <strong>{money(s.savedAmount)}</strong>
              <small>
                {s.saved.toLocaleString("en-IN")} cases ruled non-recoverable
              </small>
            </div>
            <div>
              <span>Recoverable so far</span>
              <strong>{money(s.recoverableAmount)}</strong>
              <small>
                {s.recoverable.toLocaleString("en-IN")} of{" "}
                {s.count.toLocaleString("en-IN")} cases · {money(s.amount)}{" "}
                raised
              </small>
            </div>
          </div>
          {v.canDesk && v.deskQueue ? (
            <div className={styles.workbook}>
              <div>
                <strong>
                  Cloak desk · {v.deskQueue} request
                  {v.deskQueue === 1 ? "" : "s"} to file
                </strong>
                <span>
                  Stations have sent these for filing. Download the queue, file
                  them in Cloak, and they are marked filed automatically on the
                  next hourly check.
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
            <input type="hidden" name="view" value="live" />
            {v.months.length > 1 ? (
              <label>
                Open month
                <select name="month" defaultValue={v.month} key={v.month}>
                  {v.months.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Cluster
              <select name="cluster" defaultValue={v.cluster} key={v.cluster}>
                <option value="">All my clusters</option>
                {v.clusterOptions.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Station
              <select name="station" defaultValue={v.station} key={v.station}>
                <option value="">All my stations</option>
                {v.stations.map((st) => (
                  <option key={st.id} value={st.source_code}>
                    {st.station_code} · {st.station_name}
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
            <Link href={`${base}?view=live`} className={styles.button}>
              Reset
            </Link>
          </form>
          {v.station ? (
            <>
              <div className={styles.context}>
                <Link href={href({ station: "", phase: "" })}>
                  ← All station totals
                </Link>
                <span>Station {v.station}</span>
              </div>
              <NlLiveCases
                key={[v.month, v.station, v.reason].join(":")}
                month={v.month}
                cases={v.cases}
                window={v.window}
                initialPhase={v.phase}
                canDispute={v.canDispute}
                canDesk={v.canDesk}
              />
            </>
          ) : (
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2>Station dispute overview</h2>
                <span>Stations with the most cases waiting come first</span>
              </div>
              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Current cluster · People</th>
                      <th>Raised</th>
                      <th>Waiting on station</th>
                      <th>With Amazon</th>
                      <th>Saved</th>
                      <th>Recoverable</th>
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
                        <td>{t.saved ? money(t.savedAmount) : "—"}</td>
                        <td>
                          {t.recoverable ? money(t.recoverableAmount) : "—"}
                        </td>
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
            Live data refreshes from Cloak every hour. Disputes close on the
            dispute-window date; Amazon then reviews, may ask for more details,
            and the month moves to Historic once every case is decided.
          </p>
        </>
      )}
    </main>
  );
}

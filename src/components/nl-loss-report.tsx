import { LossMultiFilter, LossTableSort } from "./loss-list-controls";
import { lossFilterValues } from "@/lib/ops-pulse/loss-list-controls";
import Link from "next/link";
import { NlLossRefresh } from "./nl-loss-refresh";
import { LossHeader, type LossTab } from "@/components/loss-header";
export { LossHeader };
import { NlLossCases } from "./nl-loss-cases";
import { LossWorkbook } from "./loss-workbook";
import { ALL_PERIODS, type NlView } from "@/lib/ops-pulse/nl-loss";
import styles from "./nl-loss.module.css";

export const LOSSES_PATH = "/team-ops/losses";
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

/** NL has two data sets in Cloak: the month still in dispute, and the months Amazon has closed. */
export function NlViewSwitch({ active }: { active: "live" | "historic" }) {
  const views = [
    { key: "live", label: "Live · dispute window", hint: "Month Amazon is still deciding" },
    { key: "historic", label: "Historic · recovery", hint: "Closed months to recover" },
  ] as const;
  return (
    <nav className={styles.viewSwitch} aria-label="Cloak data set">
      {views.map((v) => (
        <Link
          key={v.key}
          href={`${LOSSES_PATH}/nl?view=${v.key}`}
          className={active === v.key ? styles.activeView : undefined}
          aria-current={active === v.key ? "page" : undefined}
        >
          <strong>{v.label}</strong>
          <small>{v.hint}</small>
        </Link>
      ))}
    </nav>
  );
}

const COPY = {
  nl: {
    key: "nl",
    eyebrow: "Team Ops · Monthly recovery",
    title: "NL loss",
    intro:
      "Final recoverable cases from Cloak. Review the loss, then record the station recovery plan.",
    period: "Recovery month",
    value: "Recoverable loss",
    valueHint: "Amazon’s final recoverable value",
    decision: "Recoverable only",
    footer:
      "Months are retained separately as Cloak publishes them. A recovery plan records responsibility and the payroll month it is deducted in.",
  },
  slp_initial: {
    key: "slp-initial",
    eyebrow: "Team Ops · SLP recovery",
    title: "SLP · Initial recovery",
    intro:
      "Amazon’s first recovery list for the period. Assign each amount to the responsible employees.",
    period: "Period",
    value: "Initial recovery",
    valueHint: "From the EDSP SLP Initial Recovery File",
    decision: "SLP Initial file",
    footer:
      "Initial and Final list the same case, so a plan saved here is the plan shown on SLP Final. If the Final amount differs, the case is flagged for review.",
  },
  slp_final: {
    key: "slp-final",
    eyebrow: "Team Ops · SLP recovery",
    title: "SLP · Final recovery",
    intro:
      "The settled recovery for the period. Assign each amount to the responsible employees.",
    period: "Period",
    value: "Final recovery",
    valueHint: "From the EDSP SLP Final Recovery File",
    decision: "SLP Final file",
    footer:
      "SLP Initial is a report only, so employees are assigned here. A plan saved on Initial before that change is kept; a changed Final amount is flagged for review.",
  },
} as const;

export function NlLossReport({
  view: v,
  tabs,
}: {
  view: NlView;
  tabs: LossTab[];
}) {
  const copy = COPY[v.kind];
  const base = `${LOSSES_PATH}/${copy.key}`;
  const params = (station: string) => {
    const q = new URLSearchParams();
    if (v.kind === "nl") q.set("view", "historic");
    if (v.month) q.set(v.periodParam, v.month);
    if (v.cluster) q.set("cluster", v.cluster);
    if (v.reason) q.set("reason", v.reason);
    if (v.sort) q.set("sort", v.sort);
    if (station) q.set("station", station);
    return q;
  };
  const href = (station: string) => `${base}?${params(station)}`;
  const periodLabel = v.month === ALL_PERIODS ? "All periods" : lossFilterValues(v.month).map(value => v.periodOptions.find(p => p.value === value)?.label || value).join(" · ") || `No ${copy.period.toLowerCase()} available`;
  const workbookQuery = params(v.station);
  workbookQuery.set("kind", v.kind);
  return (
    <main className={styles.workspace}>
      <LossHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        intro={copy.intro}
        tabs={tabs}
        active={copy.key}
      />
      {v.kind === "nl" ? <NlViewSwitch active="historic" /> : null}
      <div className={styles.context}>
        <span>Latest check: {time(v.checked)}</span>
        {v.canRefresh ? <NlLossRefresh /> : null}
        {v.canMaster ? (
          <Link href="/master/loss-recovery">Loss Recovery Master ↗</Link>
        ) : null}
      </div>
      {v.failure ? (
        <div className={styles.notice} role="status">
          The latest refresh did not complete ({time(v.failure.finished_at)}).
          Showing the last successful data.
          <details>
            <summary>Refresh details</summary>
            {v.failure.error}
          </details>
        </div>
      ) : null}
      <form className={styles.filters} action={base}>
        {v.kind === "nl" ? (
          <input type="hidden" name="view" value="historic" />
        ) : null}
        <LossMultiFilter key={`period:${v.month}`} name={v.periodParam} label={copy.period} value={v.month === ALL_PERIODS ? "" : v.month || ""} options={v.periodOptions.filter(p => p.value !== ALL_PERIODS)} allLabel="All periods" />
        <input type="hidden" name="periodFallback" value="all" />
        <LossMultiFilter key={`cluster:${v.cluster}`} name="cluster" label="Cluster / AOM" value={v.cluster} options={v.clusterOptions} allLabel="All my clusters" />
        <LossMultiFilter key={`station:${v.station}`} name="station" label="Station" value={v.station} options={v.stations.map(s => ({ value: s.source_code, label: `${s.station_code} · ${s.station_name}` }))} allLabel="All my stations" />
        <LossMultiFilter key={`reason:${v.reason}`} name="reason" label="Loss reason" value={v.reason} options={v.reasons.map(r => ({ value: r, label: r }))} allLabel="All reasons" />
        <button className={styles.primary}>Apply filters</button>
        <Link
          href={v.kind === "nl" ? `${base}?view=historic` : base}
          className={styles.button}
        >
          Reset
        </Link>
      </form>
      <p className={styles.context}>Cluster assignments use current active People records, including for earlier loss months.</p>
      <div className={styles.monthLine}>
        <h2>{periodLabel}</h2>
        <span>
          {copy.decision} · Source refreshed {time(v.monthLastSeen)}
        </span>
      </div>
      <div className={styles.metrics}>
        <div>
          <span>{copy.value}</span>
          <strong>{money(v.totals.reduce((a, b) => a + b.amount, 0))}</strong>
          <small>{copy.valueHint}</small>
        </div>
        <div>
          <span>Cases</span>
          <strong>
            {v.totals.reduce((a, b) => a + b.count, 0).toLocaleString("en-IN")}
          </strong>
          <small>
            {v.month === ALL_PERIODS
              ? "Across all periods and selected filters"
              : `For this ${v.kind === "nl" ? "month" : "period"} and selected filters`}
          </small>
        </div>
        <div>
          <span>Stations</span>
          <strong>{v.totals.length}</strong>
          <small>Within your authorized locations</small>
        </div>
      </div>
      {v.totals.length ? (
        <LossWorkbook
          kind={v.kind}
          query={workbookQuery.toString()}
          canUpload={v.canEdit}
          scope={
            v.station
              ? `stations ${lossFilterValues(v.station).join(", ")}`
              : `${v.totals.length} station${v.totals.length === 1 ? "" : "s"} in your scope`
          }
        />
      ) : null}
      {v.station ? (
        <div className={styles.context}>
          <Link href={href("")}>← All station totals</Link>
          <span>Stations {lossFilterValues(v.station).join(", ")}</span>
        </div>
      ) : (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Station recovery overview</h2>
            <LossTableSort value={v.sort} />
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Station</th>
                  <th>Current cluster · People</th>
                  <th>Cases</th>
                  <th>{copy.value}</th>
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
          key={[v.kind, v.month, v.station, v.reason].join(":")}
          cases={v.cases}
          outcomes={v.outcomes}
          settings={v.settings}
          canEdit={v.canEdit}
          canRecovered={v.canRecovered}
          canApprove={v.canApprove}
          showPeriod={v.month === ALL_PERIODS || lossFilterValues(v.month).length > 1}
        />
      ) : null}
      <p className={styles.footer}>{copy.footer}</p>
    </main>
  );
}

"use client";
import { AdvertisingBreakdown } from "./advertising-breakdown";
import { CpsAssociateTable, CpsDaCohorts } from "./cps-associate-breakdown";
import { CpsFuelInsights } from "./cps-fuel-insights";
import { CpsRentDetails } from "./cps-rent-details";
import { CpsVanBreakdown } from "./cps-van-breakdown";
import { CpsBillPeriods } from "./cps-bill-periods";
import { Fragment, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  Fuel,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import {
  cpsReviewItems,
  groupCps,
  ratio,
  summarizeCps,
  type CpsHead,
  type CpsSnapshot,
} from "@/lib/ops-pulse/cps";

const money = (n: number | null, digits = 0) =>
  n == null
    ? "—"
    : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const count = (n: number) =>
  Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
type Head = "DA" | "UTR" | "Van" | "Other";
const groupHead = (head: CpsHead): Head =>
  head === "Rent" || head === "Overhead" ? "Other" : head;
const categories: {
  head: Head;
  label: string;
  note: string;
  icon: typeof Users;
}[] = [
  {
    head: "DA",
    label: "DA CPS",
    note: "Mapped payouts + spot DA",
    icon: Users,
  },
  {
    head: "UTR",
    label: "UTR CPS",
    note: "Station team + manager & telecaller share",
    icon: Wallet,
  },
  {
    head: "Van",
    label: "Van CPS",
    note: "Vehicle rent, drivers, fuel & ad hoc",
    icon: Truck,
  },
  {
    head: "Other",
    label: "Other CPS",
    note: "Rent, utilities, advertising & other costs",
    icon: Fuel,
  },
];
export function CpsCostWorkspace({
  snapshot,
  initialHead = "DA",
  showAttention = false,
  canResolve = true,
  canEditBilling = false,
}: {
  snapshot: CpsSnapshot;
  initialHead?: string;
  showAttention?: boolean;
  canResolve?: boolean;
  canEditBilling?: boolean;
}) {
  const [head, setHead] = useState<Head>(
    categories.some((c) => c.head === initialHead)
      ? (initialHead as Head)
      : "DA",
  );
  const [attention, setAttention] = useState(showAttention);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [issueFilter, setIssueFilter] = useState<"all" | "mapping" | "bills">(
    "all",
  );
  const total = summarizeCps(snapshot.daily);
  const costs = {
    DA: total.da,
    UTR: total.utr,
    Van: total.van,
    Other: total.other + total.rent + total.overhead,
  };
  const { gaps, bills } = cpsReviewItems(snapshot);
  const isMapping = (g: (typeof gaps)[number]) =>
    /unmapped|mapping|provider id|payment setup|rate/i.test(g.kind) &&
    g.owner === "Workforce team";
  const mappingGaps = gaps.filter(isMapping);
  const visibleGaps =
    issueFilter === "mapping"
      ? mappingGaps
      : issueFilter === "bills"
        ? []
        : gaps;
  const pendingIds = new Set(
    mappingGaps.map((g) => `${g.station_code}|${g.provider_id || g.dropx_id}`),
  ).size;
  const assumedBills = bills.length;
  const bySource = new Map<
    string,
    { label: string; source: string; head: string; amount: number }
  >();
  for (const l of snapshot.breakup) {
    if (groupHead(l.head) !== head) continue;
    const key = `${l.head}|${l.sub_head}|${l.source}`;
    const row = bySource.get(key) ?? {
      label: l.sub_head,
      source: l.source,
      head: l.head,
      amount: 0,
    };
    row.amount += Number(l.amount);
    bySource.set(key, row);
  }

  const staff = (snapshot.staff ?? []).filter(
    (p) => groupHead(p.head) === head,
  );
  const vanPeople = (snapshot.people ?? []).filter(p => p.van !== 0);
  return (
    <>
      <section className="cps-summary-strip" aria-label="CPS summary">
        <div>
          <span>Delivered shipments</span>
          <strong>{count(total.deliveries)}</strong>
          <small>For this station and selected dates</small>
        </div>
        <div className="cps-total">
          <span>
            {total.provisional || assumedBills > 0
              ? "Provisional CPS"
              : "Total CPS"}
          </span>
          <strong>{money(total.cps, 2)}</strong>
          <small>Total expenses ÷ delivered shipments</small>
        </div>
      </section>
      {(gaps.length > 0 || total.missingDays > 0 || assumedBills > 0) && (
        <section className="cps-alert" aria-live="polite">
          <CircleAlert size={20} />
          <div>
            <strong>
              {gaps.length + assumedBills} items need review
              {total.missingDays > 0
                ? ` · ${total.missingDays} days without shipment data`
                : ""}
            </strong>
            <p>
              {pendingIds} IDs need mapping / rate-card review ·{" "}
              {count(total.exposedDeliveries)} deliveries await cost mapping ·{" "}
              {assumedBills} bill periods need confirmation.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setIssueFilter("all");
              setAttention(!attention);
            }}
            aria-expanded={attention}
          >
            {attention ? "Hide issues" : "View all issues"}{" "}
            <ChevronDown size={15} />
          </button>
        </section>
      )}
      {attention && (
        <section className="panel cps-issues">
          <div className="panel-head">
            <div>
              <h2>Needs attention</h2>
              <p>
                Every pending source is listed below. Correct the source, then
                refresh CPS.
              </p>
              <div className="cps-issue-switch">
                <button
                  className="button"
                  aria-pressed={issueFilter === "all"}
                  onClick={() => setIssueFilter("all")}
                >
                  All issues ({gaps.length + assumedBills})
                </button>
                <button
                  className="button"
                  aria-pressed={issueFilter === "mapping"}
                  onClick={() => setIssueFilter("mapping")}
                >
                  Mapping &amp; rate cards ({pendingIds})
                </button>
                <button
                  className="button"
                  aria-pressed={issueFilter === "bills"}
                  onClick={() => setIssueFilter("bills")}
                >
                  Bill periods ({assumedBills})
                </button>
              </div>
            </div>
          </div>
          {issueFilter !== "bills" && (
            <div className="cps-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>Associate / vehicle &amp; IDs</th>
                    <th>Affected dates</th>
                    <th>Delivered</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleGaps.map((g) => (
                    <tr key={g.key}>
                      <td>
                        <strong>{g.kind}</strong>
                        <small>{g.owner}</small>
                      </td>
                      <td>
                        {g.name || "—"}
                        {g.dropx_id && <small>DropX ID: {g.dropx_id}</small>}
                        {g.provider_id && (
                          <small>
                            {g.owner === "Finance billing"
                              ? "Bill source ID"
                              : "Provider / vehicle ID"}: {g.provider_id}
                          </small>
                        )}
                      </td>
                      <td>
                        {g.first_date} – {g.last_date}
                        <small>
                          {g.days} affected {g.days === 1 ? "day" : "days"}
                        </small>
                      </td>
                      <td>{count(g.deliveries)}</td>
                      <td>
                        {canResolve ? (
                          <a className="button" href={g.href}>
                            {isMapping(g) ? "Complete mapping" : "Open source"}{" "}
                            <ArrowRight size={13} />
                          </a>
                        ) : (
                          g.owner
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {issueFilter !== "mapping" && assumedBills > 0 && (
            <CpsBillPeriods
              rows={bills}
              canEdit={canEditBilling}
              defaultOpen
            />
          )}
          {issueFilter === "all" && total.missingDays > 0 && (
            <p className="cps-footnote">
              Shipment data is missing for:{" "}
              {[
                ...new Set(
                  snapshot.daily
                    .filter((d) => !d.shipment_present)
                    .map((d) => d.work_date),
                ),
              ].join(", ")}
              . CPS remains provisional until the source data arrives.
            </p>
          )}
          {!visibleGaps.length &&
            (issueFilter === "mapping" || !assumedBills) && (
              <p className="panel-body">
                No matching issues in this selection.
              </p>
            )}
        </section>
      )}
      {!!snapshot.allocation_notices?.length && (
        <details className="panel cps-drilldown">
          <summary>
            Shared-cost setup needs review{" "}
            <span>{snapshot.allocation_notices.length} role notices</span>
          </summary>
          <div className="panel-body">
            {snapshot.allocation_notices.map((n) => (
              <p key={n}>{n}</p>
            ))}
            {canEditBilling && (
              <a className="button" href="/cps?view=inputs">
                Configure allocations
              </a>
            )}
          </div>
        </details>
      )}
      <div className="cps-section-title">
        <div>
          <h2>Where the money goes</h2>
          <p>Select a cost group to see its source and details.</p>
        </div>
        <span>₹ per delivered shipment</span>
      </div>
      <section className="cps-cost-cards" aria-label="Cost groups">
        {categories.map(({ head: key, label, note, icon: Icon }) => (
          <button
            type="button"
            key={key}
            className={`cps-cost-card ${key.toLowerCase()} ${head === key ? "selected" : ""}`}
            onClick={() => setHead(key)}
            aria-pressed={head === key}
            aria-controls="cps-cost-detail"
          >
            <span>
              <Icon size={18} />
              {label}
            </span>
            <strong>{money(ratio(costs[key], total.deliveries), 2)}</strong>
            <div>
              {money(costs[key])}
              <small>
                {total.total > 0
                  ? `${((costs[key] / total.total) * 100).toFixed(1)}% of cost`
                  : "No recorded cost"}
              </small>
            </div>
            <p>{note}</p>
          </button>
        ))}
      </section>
      <section
        className="panel cps-detail-panel"
        id="cps-cost-detail"
        aria-label={`${head} cost details`}
      >
        <div className="panel-head">
          <div>
            <h2>{head} cost breakdown</h2>
            <p>
              {head === "UTR"
                ? "Under the roof: active station-team CTC plus mapped manager shares up to Area Operations Manager and configured telecaller shares. Cost follows calendar days, without attendance deductions. HO / HR / Finance / Fleet costs are excluded. People names and individual salaries remain private."
                : head === "Van"
                  ? "Rent follows dated Fleet deployments. Fuel, driver costs, repairs and approved ad hoc requests are shown separately."
                  : head === "Other"
                    ? "Station rent comes from Finance Rent Master. Electricity and recurring bills are spread over their configured service period; other operating expenses follow their transaction dates."
                    : "Uses the existing Dashboard workforce payment rules and provider mappings. Spot DA payments are included separately."}
            </p>
          </div>
          <strong>{money(costs[head])}</strong>
        </div>
        {head === "DA" && <CpsDaCohorts rows={snapshot.da_details ?? []} />}
        {head === "Van" ? <CpsVanBreakdown snapshot={snapshot} deliveries={total.deliveries} amount={costs.Van}/> : <div className="cps-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cost item</th>
                <th>Source</th>
                <th>Amount</th>
                <th>CPS</th>
              </tr>
            </thead>
            <tbody>
              {[...bySource.values()]
                .sort((a, b) => b.amount - a.amount)
                .map((r) => {
                  const key = `${r.head}|${r.label}|${r.source}`;
                  const detail = snapshot.breakup.filter(
                    (l) =>
                      l.head === r.head &&
                      l.sub_head === r.label &&
                      l.source === r.source,
                  );
                  const allocations = new Map<
                    string,
                    { amount: number; dates: Set<string> }
                  >();
                  for (const l of detail) {
                    const item = allocations.get(l.station_code) ?? {
                      amount: 0,
                      dates: new Set<string>(),
                    };
                    item.amount += Number(l.amount);
                    item.dates.add(l.work_date);
                    allocations.set(l.station_code, item);
                  }
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td>
                          <button
                            className="cps-expand-item"
                            aria-expanded={expanded === key}
                            onClick={() =>
                              setExpanded(expanded === key ? null : key)
                            }
                          >
                            <ChevronDown size={16} />
                            {r.label}
                          </button>
                        </td>
                        <td>
                          <span className="cps-source-tag">{r.source}</span>
                        </td>
                        <td>{money(r.amount, 2)}</td>
                        <td>{money(ratio(r.amount, total.deliveries), 2)}</td>
                      </tr>
                      {expanded === key && (
                        <tr className="cps-expanded-row">
                          <td colSpan={4}>
                            {r.source === "Workforce rate card" && head === "DA" ? <CpsAssociateTable rows={snapshot.da_details ?? []} source={r.source} component={/fuel/i.test(r.label)?"fuel":/salary|guarantee/i.test(r.label)?"salary":"variable"}/> : r.source === "Finance Rent Master" ? <CpsRentDetails rows={snapshot.facility_rents ?? []}/> : <div className="cps-allocation-grid">
                              {[...allocations]
                                .sort(([a], [b]) => a.localeCompare(b))
                                .map(([station, item]) => (
                                  <article key={station}>
                                    <strong>{station}</strong>
                                    <span>{money(item.amount, 2)}</span>
                                    <small>
                                      {item.dates.size} cost days ·{" "}
                                      {money(
                                        ratio(
                                          item.amount,
                                          snapshot.daily
                                            .filter(
                                              (d) => d.station_code === station,
                                            )
                                            .reduce(
                                              (n, d) => n + d.deliveries,
                                              0,
                                            ),
                                        ),
                                        2,
                                      )}{" "}
                                      / delivered
                                    </small>
                                  </article>
                                ))}
                            </div>}
                            <p className="cps-footnote">
                              {r.source === "People CTC"
                                ? "Grouped staff allocation. People identities and individual CTC are kept private."
                                : r.source === "Finance Rent Master" ||
                                    r.source === "Fleet Vehicle Rent"
                                  ? "Monthly rate × applicable days ÷ calendar days in the month."
                                  : "Expand the supporting details below for source records and billing dates."}
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2}>{head} total</th>
                <th>{money(costs[head], 2)}</th>
                <th>{money(ratio(costs[head], total.deliveries), 2)}</th>
              </tr>
            </tfoot>
          </table>
        </div>}
        {head === "UTR" && !staff.some(p=>p.group !== "Manager share" && p.group !== "Telecaller share") && <p className="cps-footnote">No active station-team CTC was allocated for these dates. Check active People assignments and effective CTC if a station team should be included. Unassigned manager roles add no cost or exception.</p>}
        {!bySource.size && (
          <p className="panel-body">
            No recorded {head.toLowerCase()} costs in this period. Check the
            source issues above for missing setup.
          </p>
        )}
        {head === "Other" && <details className="cps-drilldown"><summary>Meta advertising — daily, monthly & ad details</summary><AdvertisingBreakdown rows={snapshot.advertising ?? []}/></details>}
        {staff.length > 0 && (
          <details className="cps-drilldown" open={head === "UTR"}>
            <summary>
              Staff cost allocation <span>Private · grouped costs only</span>
            </summary>
            <div className="cps-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cost group</th>
                    <th>Station</th>
                    <th>Accrual period</th>
                    <th>Allocation basis</th>
                    <th>Period cost</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((p, i) => (
                    <tr key={`${p.group}|${p.station_code}|${i}`}>
                      <td>{p.group}<small>{p.roles?.join(" · ")}</small></td>
                      <td>{p.station_code}</td>
                      <td>
                        {p.from_date} – {p.through_date}
                      </td>
                      <td>
                        {p.allocation === "delivery_share"
                          ? "Daily delivery share"
                          : "Equal share across assigned stations"}
                      </td>
                      <td>{money(p.amount, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="cps-footnote">
              Active employment dates and effective People CTC drive accrual.
              Attendance does not reduce this cost. The full allocation group is
              used even when only one station is selected.
            </p>
          </details>
        )}
        {head === "Other" && (
          <CpsBillPeriods
            rows={snapshot.expense_periods ?? []}
            canEdit={canEditBilling}
          />
        )}
        {head === "Van" && vanPeople.length > 0 && (
          <details className="cps-drilldown">
            <summary>
              Delivery-linked vehicle pay details{" "}
              <span>{vanPeople.length} station assignments</span>
            </summary>
            <div className="cps-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Associate</th>
                    <th>Station</th>
                    <th>Delivered</th>
                    <th>Fixed pay</th>
                    <th>Variable pay</th>
                    <th>Fuel</th>
                    <th>DA total</th>
                    <th>Van component</th>
                  </tr>
                </thead>
                <tbody>
                  {vanPeople.map((p) => (
                    <tr key={`${p.id}|${p.station_code}`}>
                      <td>
                        <strong>{p.name}</strong>
                        <small>{p.dropx_id}</small>
                      </td>
                      <td>{p.station_code}</td>
                      <td>{count(p.deliveries)}</td>
                      <td>{money(p.salary, 2)}</td>
                      <td>{money(p.variable, 2)}</td>
                      <td>{money(p.fuel, 2)}</td>
                      <td>{money(p.salary + p.variable + p.fuel, 2)}</td>
                      <td>{money(p.van, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="cps-footnote">
              Spot DA requests appear in the cost breakdown above. Vehicle
              per-package components are included under Van. Fixed rental comes from Fleet once; its source rules are configurable in CPS setup.
            </p>
          </details>
        )}
        {head === "Van" && <CpsFuelInsights snapshot={snapshot} />}
      </section>
      <details className="panel cps-drilldown">
        <summary>
          Daily trend{" "}
          <span>
            {new Set(snapshot.daily.map((d) => d.work_date)).size} days
          </span>
        </summary>
        <div className="cps-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Delivered</th>
                <th>DA</th>
                <th>UTR</th>
                <th>Van</th>
                <th>Other</th>
                <th>Total cost</th>
                <th>CPS</th>
              </tr>
            </thead>
            <tbody>
              {groupCps(snapshot.daily, (d) => d.work_date)
                .sort((a, b) => b.key.localeCompare(a.key))
                .map((d) => (
                  <tr key={d.key}>
                    <td>{d.key}</td>
                    <td>{count(d.deliveries)}</td>
                    <td>{money(d.da)}</td>
                    <td>{money(d.utr)}</td>
                    <td>{money(d.van)}</td>
                    <td>{money(d.other + d.rent + d.overhead)}</td>
                    <td>{money(d.total)}</td>
                    <td>{money(d.cps, 2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

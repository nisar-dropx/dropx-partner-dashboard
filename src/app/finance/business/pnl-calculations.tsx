"use client";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { LivePnl } from "@/lib/finance/pnl-data";
import type { PnlDay } from "@/lib/finance/pnl";
import type { PnlEvidence } from "@/lib/finance/pnl-evidence";
import { monthEnd } from "@/lib/finance/pricing";

const money = (n: number | string | null | undefined) =>
  n == null
    ? "—"
    : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n: number | string | null | undefined) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const sum = <T,>(rows: T[], value: (r: T) => number) =>
  rows.reduce((n, r) => n + value(r), 0);
const numeric = (v: unknown) => (v == null ? 0 : Number(v));
const known = <T,>(
  rows: T[],
  value: (r: T) => string | number | null | undefined,
) =>
  rows.some((r) => value(r) != null)
    ? sum(rows, (r) => numeric(value(r)))
    : null;
function Table({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="pnl-scroll pnl-calculation-table">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="pnl-calculation-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RevenueCalculation({
  kind,
  rows,
  report,
}: {
  kind: "base" | "xpt" | "variable" | "swa" | "mfn";
  rows: PnlDay[];
  report: LivePnl;
}) {
  const keys = new Set(rows.map((d) => `${d.station}/${d.date}`));
  const source = report.revenueCalculations.filter((d) =>
    keys.has(`${d.station}/${d.date}`) && (kind === "base" ? d.model !== "xpt" : kind === "xpt" ? d.model === "xpt" : true),
  );
  const groups = new Map<string, typeof source>();
  for (const d of source) {
    const key = `${d.station}/${d.provider}/${d.date.slice(0, 7)}`;
    groups.set(key, [...(groups.get(key) || []), d]);
  }
  if (!groups.size)
    return (
      <p className="pnl-footnote">
        No revenue calculation is available for these dates. Review missing
        shipment data and pricing.
      </p>
    );
  return (
    <div className="pnl-calculation-list">
      {[...groups].map(([key, days]) => {
        const first = days[0],
          month = first.date.slice(0, 7),
          calendarDays = Number(monthEnd(month).slice(8));
        const card = report.pricing.find(
          (p) =>
            p.station === first.station &&
            p.provider === first.provider &&
            p.month === month,
        );
        const field =
          kind === "swa" ? "swaRevenue" : kind === "mfn" ? "mfnRevenue" : kind === "xpt" ? "base" : kind;
        const amount = known(days, (d) => d[field]);
        const eligible = known(days, (d) => d.eligibleDeliveries),
          excess = known(days, (d) => d.excessVolume);
        return (
          <details className="pnl-calculation-record" key={key}>
            <summary>
              <span>
                {first.station} · {first.provider}
                <small>
                  {first.date} – {days.at(-1)!.date} · {days.length} calendar
                  days
                </small>
              </span>
              <strong>{money(amount)}</strong>
            </summary>
            <div className="pnl-calculation-body">
              <p>
                Pricing effective {card?.effective || "not configured"} ·
                revision {card?.revision ?? "—"}. Amounts below are the actual
                daily accruals used in P&L; cumulative paise rounding keeps the
                totals reconciled.
              </p>
              {(kind === "base" || kind === "xpt") && (
                <>
                  <Facts
                    items={[
                      [
                        first.model === "xpt"
                          ? "Monthly fixed payout"
                          : "Monthly minimum guarantee",
                        money(card?.mg),
                      ],
                      ["Monthly fee", money(card?.monthlyFee)],
                      ["Calendar month days", calendarDays],
                      ["Days considered", days.length],
                      ["Recorded accrual", money(amount)],
                    ]}
                  />
                  <p className="pnl-formula">
                    ({money(card?.mg)} + {money(card?.monthlyFee ?? 0)}) ÷{" "}
                    {calendarDays} × {days.length} days = {money(amount)}
                    {first.model === "xpt" ? " · XPT fixed payout" : ""}
                  </p>
                  <Table
                    headers={["Date", "Fixed / MG accrual", "Shipment report"]}
                  >
                    {days.map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td>{money(d.base)}</td>
                        <td>
                          {d.shipmentReported
                            ? "Available"
                            : "Pending · fixed revenue accrues"}
                        </td>
                      </tr>
                    ))}
                  </Table>
                </>
              )}
              {kind === "variable" && (
                <>
                  <Facts
                    items={[
                      [
                        first.model === "xpt"
                          ? "Parent delivery rate"
                          : "Delivery rate",
                        money(card?.variable),
                      ],
                      [
                        "Monthly MG volume",
                        first.model === "xpt"
                          ? "No MG threshold"
                          : qty(card?.mgVolume),
                      ],
                      ["Eligible deliveries + C-returns", qty(eligible)],
                      ["Billable excess / XPT volume", qty(excess)],
                      ["Variable earnings", money(amount)],
                    ]}
                  />
                  <p className="pnl-formula">
                    {first.model === "slab"
                      ? "Monthly cumulative delivered volume uses the configured slabs. Each date records the change in cumulative earnings."
                      : first.model === "xpt"
                        ? `All eligible XPT deliveries × ${money(card?.variable)} (parent ${card?.parent || "not configured"}). No MG threshold.`
                        : `Each day: max(0, Amazon deliveries + C-returns − ${qty(card?.mgVolume)} ÷ ${calendarDays}) × ${money(card?.variable)}. SWA is excluded. Daily shortfalls do not offset another day’s excess.`}
                  </p>
                  {first.model === "slab" && (
                    <Table headers={["Above", "Up to", "Rate / delivery"]}>
                      {card?.slabs.map((s, i) => (
                        <tr key={i}>
                          <td>{qty(s.above)}</td>
                          <td>
                            {s.upto == null ? "No upper limit" : qty(s.upto)}
                          </td>
                          <td>{money(s.rate)}</td>
                        </tr>
                      ))}
                    </Table>
                  )}
                  <Table
                    headers={[
                      "Date",
                      "Amazon / delivered",
                      "C-returns",
                      "Eligible",
                      "MG threshold",
                      "Within MG",
                      "Additional",
                      "Earnings",
                    ]}
                  >
                    {days.map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td>
                          {d.eligibleDeliveries == null
                            ? "—"
                            : qty(
                                Number(d.eligibleDeliveries) -
                                  Number(d.returns || 0),
                              )}
                        </td>
                        <td>{qty(d.returns)}</td>
                        <td>{qty(d.eligibleDeliveries)}</td>
                        <td>{qty(d.mgVolume)}</td>
                        <td>
                          {d.mgVolume == null || d.eligibleDeliveries == null
                            ? "—"
                            : qty(
                                Math.min(
                                  Number(d.mgVolume),
                                  Number(d.eligibleDeliveries),
                                ),
                              )}
                        </td>
                        <td>{qty(d.excessVolume)}</td>
                        <td>{money(d.variable)}</td>
                      </tr>
                    ))}
                  </Table>
                </>
              )}
              {(kind === "swa" || kind === "mfn") && (
                <>
                  <Facts
                    items={[
                      [
                        kind === "swa" ? "SWA delivered" : "MFN count",
                        qty(
                          known(days, (d) => (kind === "swa" ? d.swa : d.mfn)),
                        ),
                      ],
                      [
                        "Rate",
                        money(kind === "swa" ? card?.swaRate : card?.mfn),
                      ],
                      ["Earnings", money(amount)],
                    ]}
                  />
                  <p className="pnl-formula">
                    Quantity × configured rate.{" "}
                    {kind === "swa"
                      ? "SWA stays separate from Amazon MG. Matching delivery rates are provisional until the contract rate is confirmed."
                      : "An unconfigured XPT MFN settlement remains pending."}
                  </p>
                  <Table headers={["Date", "Quantity", "Earnings"]}>
                    {days.map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td>{qty(kind === "swa" ? d.swa : d.mfn)}</td>
                        <td>
                          {money(kind === "swa" ? d.swaRevenue : d.mfnRevenue)}
                        </td>
                      </tr>
                    ))}
                  </Table>
                </>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function useFinanceEvidence(rows: PnlDay[], version: string) {
  const [enabled, setEnabled] = useState(false),
    [attempt, setAttempt] = useState(0);
  const dates = rows
    .filter(
      (r) => r.cost !== null || r.revenue !== null || r.deliveries !== null,
    )
    .map((r) => r.date)
    .sort();
  const q = new URLSearchParams({
    stations: [...new Set(rows.map((r) => r.station))].sort().join(","),
    from: dates[0] || "",
    to: dates.at(-1) || "",
  });
  const url = `/finance/business/details?${q}`,
    key = `${url}/${version}/${attempt}`;
  const [result, setResult] = useState<{
    key: string;
    data?: PnlEvidence;
    error?: string;
  }>();
  const hasDates = dates.length > 0;
  useEffect(() => {
    if (!enabled || !hasDates) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw Error("Calculation details could not be loaded. Please retry.");
        if (!response.headers.get("content-type")?.includes("application/json"))
          throw Error(
            "Your session has changed. Refresh this page to continue.",
          );
        return (await response.json()) as PnlEvidence;
      })
      .then((data) => setResult({ key, data }))
      .catch((error: Error) => {
        if (error.name !== "AbortError")
          setResult({ key, error: error.message });
      });
    return () => controller.abort();
  }, [enabled, url, key, hasDates]);
  return {
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
    empty: !dates.length,
    load: () => setEnabled(true),
    retry: () => setAttempt((a) => a + 1),
  };
}

export function ExpenseCalculation({
  head,
  evidence,
}: {
  head: string;
  evidence: ReturnType<typeof useFinanceEvidence>;
}) {
  const { data, error, empty } = evidence;
  if (empty)
    return (
      <p className="pnl-footnote">
        No delivered-data report is available, so costs have not been accrued in
        this P&L.
      </p>
    );
  if (error)
    return (
      <div className="pnl-footnote" role="alert">
        {error}{" "}
        <button type="button" className="pnl-btn" onClick={evidence.retry}>
          Retry details
        </button>
      </div>
    );
  if (!data)
    return (
      <p className="pnl-footnote" role="status">
        Loading source records and calculations…
      </p>
    );
  const ledger = data.ledger.filter((l) =>
    head === "Other" ? ["Other", "Overhead"].includes(l.head) : l.head === head,
  );
  const staff = data.staff.filter((s) =>
    head === "Other" ? ["Other", "Overhead"].includes(s.head) : s.head === head,
  );
  const associates = data.associates.filter((a) =>
    head === "DA"
      ? a.salary + a.variable + a.fuel !== 0
      : head === "Van" && a.van !== 0,
  );
  return (
    <div className="pnl-calculation-list">
      <p className="pnl-footnote">
        {head === "UTR"
          ? "Active People remuneration, including station contractors. Roster and attendance do not reduce this cost. Shared roles use the complete mapped-station group."
          : "These are calculated operating costs for the delivered-data dates, before final payment settlement."}
      </p>
      {head === "DA" &&
        ["variable", "guarantee"].map((cohort) => {
          const group = associates.filter((a) => a.cohort === cohort),
            pay = sum(group, (a) => a.salary + a.variable + a.fuel),
            delivered = sum(group, (a) => a.deliveries);
          return (
            <Facts
              key={cohort}
              items={[
                [
                  cohort === "variable"
                    ? "Variable-pay associates"
                    : "Salary / minimum-guarantee associates",
                  group.length,
                ],
                ["Delivered", qty(delivered)],
                ["Calculated pay", money(pay)],
                [
                  "CPS for these associates",
                  delivered ? money(pay / delivered) : "—",
                ],
              ]}
            />
          );
        })}
      {associates.map((a) => {
        const payout = head === "Van" ? a.van : a.salary + a.variable + a.fuel;
        return (
          <details
            className="pnl-calculation-record"
            key={`${a.worker_id}/${a.station_code}/${a.cohort}`}
          >
            <summary>
              <span>
                {a.name} · {a.dropx_id}
                <small>
                  {a.station_code} ·{" "}
                  {a.cohort === "guarantee"
                    ? "Salary / minimum guarantee"
                    : "Variable pay"}{" "}
                  · {a.work_dates.length} worked days · {qty(a.deliveries)}{" "}
                  delivered
                </small>
              </span>
              <strong>{money(payout)}</strong>
            </summary>
            <div className="pnl-calculation-body">
              <Facts
                items={[
                  [
                    "Provider IDs",
                    a.provider_ids.join(", ") || "Direct allocation",
                  ],
                  ["Cost days", a.cost_dates.length],
                  ["Worked days", a.work_dates.length],
                  ["Fixed / guarantee top-up", money(a.salary)],
                  ["Variable pay", money(a.variable)],
                  ["DA fuel", money(a.fuel)],
                  ["Vehicle component", money(a.van)],
                  [
                    "DA CPS",
                    a.deliveries
                      ? money((a.salary + a.variable + a.fuel) / a.deliveries)
                      : "—",
                  ],
                ]}
              />
              <p>
                Work evidence:{" "}
                {a.work_bases.join(", ") || "No work evidence recorded"}.
                Vehicle components are counted under Van; they are excluded from
                DA CPS. Minimum guarantee may appear as a top-up after variable
                earnings.
              </p>
              {a.periods.map((p, i) => (
                <details className="pnl-calculation-record" key={i}>
                  <summary>
                    <span>
                      Rate card from {p.card_from}
                      <small>
                        {p.from} – {p.to} · {p.source}
                      </small>
                    </span>
                    <strong>
                      {money(
                        head === "Van" ? p.van : p.salary + p.variable + p.fuel,
                      )}
                    </strong>
                  </summary>
                  <div className="pnl-calculation-body">
                    <Table headers={["Component", "Rate", "Calculation basis"]}>
                      {p.rates.map((r, i) => (
                        <tr key={i}>
                          <td>{r.label}</td>
                          <td>{money(r.rate)}</td>
                          <td>{r.basis}</td>
                        </tr>
                      ))}
                    </Table>
                    <Facts
                      items={[
                        ["Delivered", qty(p.deliveries)],
                        ["Customer returns", qty(p.customer_returns)],
                        ["Seller pickups", qty(p.seller_pickups)],
                        ["Seller returns", qty(p.seller_returns)],
                      ]}
                    />
                  </div>
                </details>
              ))}
              <details className="pnl-calculation-record">
                <summary>Day-by-day work and calculated pay</summary>
                <Table
                  headers={[
                    "Date",
                    "Worked",
                    "Delivered",
                    "C-returns",
                    "Pickups / returns",
                    "Fixed",
                    "Variable",
                    "Fuel",
                    "Vehicle",
                    "DA pay",
                  ]}
                >
                  {data.associateDays
                    .filter(
                      (d) =>
                        d.worker_id === a.worker_id &&
                        d.station_code === a.station_code &&
                        d.cohort === a.cohort,
                    )
                    .map((d, i) => (
                      <tr key={i}>
                        <td>{d.date}</td>
                        <td>{d.worked ? "Yes" : "No work evidence"}</td>
                        <td>{qty(d.deliveries)}</td>
                        <td>{qty(d.customer_returns)}</td>
                        <td>
                          {qty(d.seller_pickups)} / {qty(d.seller_returns)}
                        </td>
                        <td>{money(d.salary)}</td>
                        <td>{money(d.variable)}</td>
                        <td>{money(d.fuel)}{d.input_estimates?.map((e,j)=><small key={j} style={{display:'block'}}>Estimated · {e.label}: {qty(e.units)} × {money(e.rate)} · {e.basis}. History {e.history_from}–{e.history_to}: {qty(e.history_units)} ÷ {qty(e.history_work_days)} worked days.</small>)}</td>
                        <td>{money(d.van)}</td>
                        <td>{money(d.salary + d.variable + d.fuel)}</td>
                      </tr>
                    ))}
                </Table>
              </details>
            </div>
          </details>
        );
      })}
      {staff.map((s) => {
        const groups = new Map<string, typeof s.days>();
        for (const d of s.days) {
          const key = `${d.date.slice(0, 7)}/${d.card_from}/${d.monthly_ctc}/${d.allocation}/${d.station_count}`;
          groups.set(key, [...(groups.get(key) || []), d]);
        }
        return (
          <details
            className="pnl-calculation-record"
            key={`${s.person_id}/${s.station}/${s.group}`}
          >
            <summary>
              <span>
                {s.name} · {s.code}
                <small>
                  {s.role} · {s.station} · {s.group}
                </small>
              </span>
              <strong>{money(s.amount)}</strong>
            </summary>
            <div className="pnl-calculation-body">
              {[...groups].map(([key, days]) => {
                const d = days[0];
                return (
                  <div key={key}>
                    <Facts
                      items={[
                        ["Monthly CTC / remuneration", money(d.monthly_ctc)],
                        ["Pay effective from", d.card_from],
                        [
                          "Days considered",
                          `${days.length} / ${d.calendar_days}`,
                        ],
                        [
                          "Allocation",
                          `${d.allocation === "equal" ? "Equal" : "Delivery-weighted"} · ${d.station_count} mapped stations`,
                        ],
                        ["Station cost", money(sum(days, (r) => r.amount))],
                      ]}
                    />
                    <p className="pnl-formula">
                      {money(d.monthly_ctc)} ÷ {d.calendar_days} × {days.length}{" "}
                      calendar days
                      {d.allocation === "equal"
                        ? ` ÷ ${d.station_count} mapped stations`
                        : " × each day’s station delivery share"}{" "}
                      = {money(sum(days, (r) => r.amount))}. Rounded daily
                      allocation is shown below.
                    </p>
                  </div>
                );
              })}
              <details className="pnl-calculation-record">
                <summary>Daily salary and allocation</summary>
                <Table
                  headers={[
                    "Date",
                    "Monthly amount",
                    "Month days",
                    "Daily accrual",
                    "Station share",
                    "Allocated cost",
                  ]}
                >
                  {s.days.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>{money(d.monthly_ctc)}</td>
                      <td>{d.calendar_days}</td>
                      <td>{money(d.daily_ctc)}</td>
                      <td>
                        {qty(d.station_weight)} / {qty(d.total_weight)}
                      </td>
                      <td>{money(d.amount)}</td>
                    </tr>
                  ))}
                </Table>
              </details>
            </div>
          </details>
        );
      })}
      {head === "Rent" &&
        data.rents.map((r, i) => (
          <details className="pnl-calculation-record" key={`${r.id}/${i}`}>
            <summary>
              <span>
                {r.site} · {r.payee}
                <small>
                  {r.station} · {r.from} – {r.to}
                </small>
              </span>
              <strong>{money(r.amount)}</strong>
            </summary>
            <div className="pnl-calculation-body">
              <Facts
                items={[
                  ["Actual monthly rent", money(r.monthly_rent)],
                  ["Monthly maintenance", money(r.monthly_maintenance)],
                  ["Effective from", r.effective_from],
                  ["Calendar month days", r.calendar_days],
                  ["Days considered", r.days],
                ]}
              />
              <p className="pnl-formula">
                ({money(r.monthly_rent)} + {money(r.monthly_maintenance)}) ÷{" "}
                {r.calendar_days} × {r.days} days = {money(r.amount)}.
              </p>
              <a href="/master/rent">Open Rent Master →</a>
            </div>
          </details>
        ))}
      {head === "Van" &&
        data.vehicles.map((v, i) => (
          <details
            className="pnl-calculation-record"
            key={`${v.vehicle_id}/${i}`}
          >
            <summary>
              <span>
                {v.vehicle_no} · {v.model}
                <small>
                  {v.station_code} · {v.considered_from} – {v.considered_to}
                </small>
              </span>
              <strong>{money(v.considered_amount)}</strong>
            </summary>
            <div className="pnl-calculation-body">
              <Facts
                items={[
                  [v.daily_rent != null ? "Daily vehicle rent" : "Monthly vehicle rent", money(v.daily_rent ?? v.monthly_rent)],
                  ["Rent-blocked days", v.rent_blocked_days],
                  ["Month days", v.calendar_days],
                  [
                    "Deployed cost days",
                    v.considered_days ?? "Split deployment · see ledger",
                  ],
                ]}
              />
              <p className="pnl-formula">
                {v.daily_rent != null ? `${money(v.daily_rent)} per eligible day` : `${money(v.monthly_rent)} ÷ ${v.calendar_days} calendar days`}.
                {" "}{v.considered_days ?? "Recorded"} deployed days; {v.rent_blocked_days} rent-blocked days.
                {" "}Fleet ledger cost: {money(v.considered_amount)}, counted once. Dashboard fixed rental is excluded by the configured source rule; per-package pay remains included.
              </p>
            </div>
          </details>
        ))}
      {data.bills
        .filter((b) =>
          ledger.some(
            (l) => l.station_code === b.station_code && l.sub_head === b.label,
          ),
        )
        .map((b) => (
          <details
            className="pnl-calculation-record"
            key={`${b.source}/${b.source_id}`}
          >
            <summary>
              <span>
                {b.reference || b.source_id} · {b.label}
                <small>
                  {b.station_code} · {b.source} ·{" "}
                  {b.confirmed
                    ? "Billing period confirmed"
                    : "Billing period needs confirmation"}
                </small>
              </span>
              <strong>{money(b.considered_amount)}</strong>
            </summary>
            <div className="pnl-calculation-body">
              <Facts
                items={[
                  ["Full bill", money(b.amount)],
                  ["Bill period", `${b.period_from} – ${b.period_to}`],
                  [
                    "Considered period",
                    `${b.considered_from} – ${b.considered_to}`,
                  ],
                  [
                    "Days considered",
                    `${b.considered_days} / ${b.period_days}`,
                  ],
                ]}
              />
              <p className="pnl-formula">
                {money(b.amount)} ÷ {b.period_days} bill-period days ×{" "}
                {b.considered_days} days = {money(b.considered_amount)}.
              </p>
            </div>
          </details>
        ))}
      {head === "Van" && data.fuel.length > 0 && (
        <details className="pnl-calculation-record">
          <summary>
            <span>
              Fuel transactions
              <small>IOCL / BPCL imports · actual transaction dates</small>
            </span>
            <strong>{money(sum(data.fuel, (f) => Number(f.amount)))}</strong>
          </summary>
          <Table
            headers={[
              "Date",
              "Station",
              "Vehicle",
              "Provider / reference",
              "Product",
              "Litres",
              "Cost / litre",
              "Amount",
            ]}
          >
            {data.fuel.map((f) => (
              <tr key={f.id}>
                <td>{f.transaction_date}</td>
                <td>{f.station_code}</td>
                <td>{f.vehicle_no || "Unspecified"}</td>
                <td>
                  {f.provider} · {f.transaction_id}
                </td>
                <td>{f.product || "—"}</td>
                <td>{qty(f.litres)}</td>
                <td>
                  {Number(f.litres)
                    ? money(Number(f.amount) / Number(f.litres))
                    : "—"}
                </td>
                <td>{money(f.amount)}</td>
              </tr>
            ))}
          </Table>
          <p className="pnl-footnote">
            Cashbook fuel and associate fuel allowances are listed separately in
            the source ledger.
          </p>
        </details>
      )}
      <details className="pnl-calculation-record">
        <summary>
          <span>
            Daily source ledger
            <small>All costs included in this expense group</small>
          </span>
          <strong>{money(sum(ledger, (l) => l.amount))}</strong>
        </summary>
        <Table headers={["Date", "Station", "Cost item", "Source", "Amount"]}>
          {ledger.map((l, i) => (
            <tr key={i}>
              <td>{l.work_date}</td>
              <td>{l.station_code}</td>
              <td>{l.sub_head}</td>
              <td>{l.source}</td>
              <td>{money(l.amount)}</td>
            </tr>
          ))}
        </Table>
        {!ledger.length && (
          <p className="pnl-footnote">
            No recorded cost. Missing setup remains in Items to review.
          </p>
        )}
      </details>
    </div>
  );
}

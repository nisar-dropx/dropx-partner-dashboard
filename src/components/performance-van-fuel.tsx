"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  fuelDates,
  fuelInDates,
  fuelTotals,
  fuelVehicleRows,
  type FuelEntry,
  type FuelPeriod,
  type ReviewFuel,
} from "@/lib/ops-pulse/review-fuel";
import "@/app/ops-pulse/performance/review-fuel.css";

const money = (value: number) =>
  `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const litres = (value: number | null) =>
  value == null
    ? "—"
    : `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

export function FuelVehicleTable({
  data,
  period,
}: {
  data: ReviewFuel;
  period: FuelPeriod;
}) {
  const [measure, setMeasure] = useState<"amount" | "litres">("amount");
  const dates = fuelDates(data.date, period),
    month = fuelDates(data.date, "mtd"),
    groups = fuelVehicleRows(data, dates);
  const value = (entries: FuelEntry[], source: FuelEntry["source"]) => {
    const totals = fuelTotals(entries);
    return measure === "amount"
      ? money(source === "card" ? totals.card : totals.portal)
      : source === "portal"
        ? "—"
        : litres(totals.litres);
  };
  return (
    <div className="review-fuel-vehicles">
      <div className="review-fuel-toolbar">
        <h4>Vehicle-wise daily fillings</h4>
        <div role="group" aria-label="Fuel table measure">
          <button
            type="button"
            aria-pressed={measure === "amount"}
            onClick={() => setMeasure("amount")}
          >
            Amount
          </button>
          <button
            type="button"
            aria-pressed={measure === "litres"}
            onClick={() => setMeasure("litres")}
          >
            Litres filled
          </button>
        </div>
      </div>
      <div
        className="review-fuel-scroll"
        tabIndex={0}
        role="region"
        aria-label="Vehicle fuel daily table, scroll for all dates"
      >
        <table>
          <caption>
            {data.station} · {dayLabel(dates[0])}–{dayLabel(data.date)} · MTD
            starts {dayLabel(month[0])}
          </caption>
          <thead>
            <tr>
              <th scope="col">Vehicle / source</th>
              {dates.map((day) => (
                <th scope="col" key={day}>
                  {dayLabel(day)}
                </th>
              ))}
              <th scope="col">Period total</th>
              <th scope="col">MTD total</th>
              <th scope="col">Filling days</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const selected = group.entries.filter((e) =>
                  dates.includes(e.date),
                ),
                monthly = group.entries.filter((e) => month.includes(e.date));
              return (
                <tr key={group.key}>
                  <th scope="row">
                    {group.vehicle || "Vehicle not recorded"}
                    <small>
                      {group.source === "card" ? "Fuel card" : "Portal expense"}
                    </small>
                  </th>
                  {dates.map((day) => (
                    <td key={day}>
                      {value(
                        group.entries.filter((e) => e.date === day),
                        group.source,
                      )}
                    </td>
                  ))}
                  <td>
                    <b>{value(selected, group.source)}</b>
                  </td>
                  <td>
                    <b>{value(monthly, group.source)}</b>
                  </td>
                  <td>
                    {group.source === "card"
                      ? `${fuelTotals(selected).fillingDays}/${dates.length}`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!groups.length ? (
        <p>No vehicle fuel entries recorded in this period or month.</p>
      ) : null}
      <p className="review-fuel-note">
        Unknown vehicles stay unallocated. Litres are fillings, not measured
        fuel consumption.
      </p>
    </div>
  );
}

function FuelExpandedDetails({
  data,
  period,
  setPeriod,
  onClose,
}: {
  data: ReviewFuel;
  period: FuelPeriod;
  setPeriod: (value: FuelPeriod) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    title = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="review-fuel-dialog review-fuel-history"
      aria-labelledby={title}
      onClose={() => { if (!dialog.current?.open) onClose(); }}
    >
      <div className="review-fuel-toolbar">
        <div>
          <h3 id={title}>Van fuel · {data.station}</h3>
          <span>
            Through {dayLabel(data.date)}, {data.date.slice(0, 4)}
          </span>
        </div>
        <button
          type="button"
          autoFocus
          onClick={() => dialog.current?.close()}
          aria-label="Close vehicle fuel details"
        >
          Close
        </button>
      </div>
      <div className="review-fuel-toolbar">
        <div role="group" aria-label="Expanded fuel history period">
          {([7, 14, "mtd"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {value === "mtd" ? "MTD" : `${value} days`}
            </button>
          ))}
        </div>
      </div>
      <FuelVehicleTable data={data} period={period} />
      <p className="review-fuel-note">
        Card and portal expenses remain separate to avoid duplicate counting.
        Scroll the table for every date and each vehicle’s period and MTD
        totals.
      </p>
    </dialog>
  );
}

export function FuelHistory({ data }: { data: ReviewFuel }) {
  const [period, setPeriod] = useState<FuelPeriod>(7),
    [expanded, setExpanded] = useState(false);
  const dates = fuelDates(data.date, period),
    entries = fuelInDates(data, dates),
    totals = fuelTotals(entries),
    mtd = fuelTotals(fuelInDates(data, fuelDates(data.date, "mtd")));
  return (
    <div className="review-fuel-history">
      <div className="review-fuel-toolbar">
        <div role="group" aria-label="Fuel history period">
          {([7, 14, "mtd"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {value === "mtd" ? "MTD" : `${value} days`}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide vehicle table" : "Expand vehicle table"}
        </button>
      </div>
      <div className="review-fuel-totals">
        <div>
          <span>Card fillings · period</span>
          <strong>{money(totals.card)}</strong>
          <small>
            MTD {money(mtd.card)} · {litres(mtd.litres)}
          </small>
        </div>
        <div>
          <span>Approved portal · period</span>
          <strong>{money(totals.portal)}</strong>
          <small>MTD {money(mtd.portal)}</small>
        </div>
      </div>
      <p className="review-fuel-note">
        Sources are shown separately: portal requests may cover a card filling
        and cannot yet be reliably matched.
      </p>
      <div
        className="review-fuel-scroll review-fuel-daily"
        tabIndex={0}
        role="region"
        aria-label="Daily fuel amounts"
      >
        <table>
          <caption>Daily values · {data.station} · newest first</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Card fillings</th>
              <th scope="col">Litres</th>
              <th scope="col">Portal</th>
            </tr>
          </thead>
          <tbody>
            {[...dates].reverse().map((day) => {
              const summary = fuelTotals(entries.filter((e) => e.date === day));
              return (
                <tr key={day}>
                  <th scope="row">
                    <time dateTime={day}>{dayLabel(day)}</time>
                  </th>
                  <td>{money(summary.card)}</td>
                  <td>{litres(summary.litres)}</td>
                  <td>{money(summary.portal)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="review-fuel-pattern">
        <span>
          <b>{totals.fills}</b> recorded fillings
        </span>
        <span>
          <b>
            {totals.fillingDays}/{dates.length}
          </b>{" "}
          filling days
        </span>
        <span>
          <b>{dates.length - totals.fillingDays}</b> days without a recorded
          filling
        </span>
        <span>
          Average filling{" "}
          <b>{totals.fills ? money(totals.card / totals.fills) : "—"}</b>
        </span>
      </div>
      {expanded ? (
        <FuelExpandedDetails
          data={data}
          period={period}
          setPeriod={setPeriod}
          onClose={() => setExpanded(false)}
        />
      ) : null}
      <details className="review-fuel-entries">
        <summary>Filling and expense details · {entries.length}</summary>
        <div
          className="review-fuel-scroll"
          tabIndex={0}
          role="region"
          aria-label="Fuel source records"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Date / reference</th>
                <th scope="col">Vehicle / source</th>
                <th scope="col">Amount</th>
                <th scope="col">Litres</th>
              </tr>
            </thead>
            <tbody>
              {[...entries].reverse().map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    {dayLabel(entry.date)}
                    <small>{entry.reference}</small>
                  </th>
                  <td>
                    {entry.vehicle || "Vehicle not recorded"}
                    <small>{entry.provider}</small>
                    {entry.note ? <small>{entry.note}</small> : null}
                  </td>
                  <td>{money(entry.amount)}</td>
                  <td>{litres(entry.litres)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="review-fuel-note">
        ₹0 means no entry recorded, not confirmation of no fuel use. Latest
        recorded card filling:{" "}
        {data.latestCardDate ? dayLabel(data.latestCardDate) : "none"}; portal
        expense:{" "}
        {data.latestPortalDate ? dayLabel(data.latestPortalDate) : "none"}.
        Existing CPS totals are unchanged.
      </p>
    </div>
  );
}

export function PerformanceVanFuel({
  station,
  date,
}: {
  station: string;
  date: string;
}) {
  const [data, setData] = useState<ReviewFuel | null>(null),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0),
    [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 58000);
    setData(null);
    setError(false);
    setOpen(false);
    fetch(
      `/api/ops-pulse/performance/fuel?${new URLSearchParams({ station, date })}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw Error("Fuel unavailable");
        return response.json() as Promise<ReviewFuel>;
      })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [station, date, retry]);
  if (error)
    return (
      <div className="review-fuel-load" role="status">
        Van fuel expenses could not be loaded.{" "}
        <button type="button" onClick={() => setRetry(retry + 1)}>
          Retry
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="review-fuel-load" role="status">
        Loading van fuel expenses…
      </div>
    );
  if (!data.available) return null;
  const today = fuelTotals(data.entries.filter((e) => e.date === date));
  return (
    <section className="review-van-fuel" aria-label="Van fuel expenses">
      <button
        type="button"
        className="review-fuel-card"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span>
          <b>Van fuel expenses</b>
          <small>
            {dayLabel(date)} ·{" "}
            {open ? "Close history" : "7 days · 14 days · MTD"}
          </small>
        </span>
        <span className="review-fuel-card-values">
          <span>
            <small>Card fillings</small>
            <strong>{money(today.card)}</strong>
          </span>
          <span>
            <small>Approved portal</small>
            <strong>{money(today.portal)}</strong>
          </span>
          <b aria-hidden="true">{open ? "−" : "+"}</b>
        </span>
      </button>
      {open ? (
        <div id={id}>
          <FuelHistory data={data} />
        </div>
      ) : null}
    </section>
  );
}

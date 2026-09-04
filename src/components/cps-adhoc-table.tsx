"use client";

import { ChevronDown } from "lucide-react";
import { Fragment, useState } from "react";
import type { AdHocActivityStation } from "@/lib/ops-pulse/adhoc-activity";

function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
    .format(new Date(`${value}T12:00:00+05:30`));
}

export function CpsAdHocTable({ stations }: { stations: AdHocActivityStation[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="table-wrap cps-adhoc-table-wrap">
      <table className="cps-adhoc-table">
        <thead><tr><th>Station</th><th>Adhoc Van</th><th>Van amount</th><th>Adhoc DA</th><th>DA amount</th><th>Total jobs</th><th>Total amount</th></tr></thead>
        <tbody>
          {stations.map((station) => {
            const open = expanded === station.id;
            return <Fragment key={station.id}>
              <tr className={`${station.totalCount ? "has-activity" : "no-activity"} ${open ? "expanded" : ""}`.trim()}>
                <td><button className="cps-adhoc-station-button" disabled={!station.totalCount} onClick={() => setExpanded(open ? null : station.id)} type="button"><span><strong>{station.code}</strong><small>{station.name} · {station.cluster}</small></span>{station.totalCount ? <ChevronDown aria-hidden="true" size={16} /> : null}</button></td>
                <td><strong>{station.vanCount}</strong></td>
                <td>{money(station.vanAmount)}</td>
                <td><strong>{station.daCount}</strong></td>
                <td>{money(station.daAmount)}</td>
                <td><strong>{station.totalCount}</strong></td>
                <td><strong>{money(station.totalAmount)}</strong></td>
              </tr>
              {open ? <tr className="cps-adhoc-day-row"><td colSpan={7}>
                <div className="cps-adhoc-day-panel">
                  <header><strong>{station.code} · day-level activity</strong><span>{station.days.length} active day{station.days.length === 1 ? "" : "s"}</span></header>
                  <div className="cps-adhoc-day-grid cps-adhoc-day-grid-head"><span>Date</span><span>Van</span><span>Van amount</span><span>DA</span><span>DA amount</span><span>Total</span></div>
                  {station.days.map((day) => <div className="cps-adhoc-day-grid" key={day.date}>
                    <strong>{dateLabel(day.date)}</strong><span>{day.vanCount}</span><span>{money(day.vanAmount)}</span><span>{day.daCount}</span><span>{money(day.daAmount)}</span><strong>{day.totalCount} · {money(day.totalAmount)}</strong>
                  </div>)}
                </div>
              </td></tr> : null}
            </Fragment>;
          })}
          {!stations.length ? <tr><td className="empty-cell" colSpan={7}>No permitted stations match the selected filters.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

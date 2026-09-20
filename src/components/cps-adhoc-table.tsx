"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Download } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { AdHocActivityStation } from "@/lib/ops-pulse/adhoc-activity";
import {
  sortAdHocStations,
  type AdHocSortDirection,
  type AdHocSortKey,
} from "@/lib/ops-pulse/adhoc-activity-sort";

function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
    .format(new Date(`${value}T12:00:00+05:30`));
}

function SortHeader({
  active,
  column,
  direction,
  label,
  onSort,
}: {
  active: boolean;
  column: AdHocSortKey;
  direction: AdHocSortDirection;
  label: string;
  onSort: (column: AdHocSortKey) => void;
}) {
  return (
    <th aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button className="cps-adhoc-sort" onClick={() => onSort(column)} type="button">
        <span>{label}</span>
        {active ? direction === "asc" ? <ArrowUp aria-hidden="true" size={12} /> : <ArrowDown aria-hidden="true" size={12} /> : <ArrowUpDown aria-hidden="true" size={12} />}
      </button>
    </th>
  );
}

export function CpsAdHocTable({ stations, reportParams }: { stations: AdHocActivityStation[]; reportParams: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<AdHocSortKey>("totalAmount");
  const [sortDirection, setSortDirection] = useState<AdHocSortDirection>("desc");
  const sortedStations = useMemo(
    () => sortAdHocStations(stations, sortKey, sortDirection),
    [stations, sortDirection, sortKey],
  );
  const sort = (column: AdHocSortKey) => {
    if (column === sortKey) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else {
      setSortKey(column);
      setSortDirection(column === "station" ? "asc" : "desc");
    }
  };
  const exportUrl = `/api/ops-pulse/cps/adhoc-activity/report?${reportParams}&sort=${sortKey}&direction=${sortDirection}`;

  return (
    <>
      <div className="cps-adhoc-table-tools">
        <span>Click any heading to sort. Click a date for reasons and remarks.</span>
        <a className="button secondary cps-adhoc-download" href={exportUrl}>
          <Download aria-hidden="true" size={14} /> Download Excel
        </a>
      </div>
      <div className="table-wrap cps-adhoc-table-wrap">
        <table className="cps-adhoc-table">
          <thead><tr>
            <SortHeader active={sortKey === "station"} column="station" direction={sortDirection} label="Station" onSort={sort} />
            <SortHeader active={sortKey === "vanCount"} column="vanCount" direction={sortDirection} label="Adhoc Van" onSort={sort} />
            <SortHeader active={sortKey === "vanAmount"} column="vanAmount" direction={sortDirection} label="Van amount" onSort={sort} />
            <SortHeader active={sortKey === "daCount"} column="daCount" direction={sortDirection} label="Adhoc DA" onSort={sort} />
            <SortHeader active={sortKey === "daAmount"} column="daAmount" direction={sortDirection} label="DA amount" onSort={sort} />
            <SortHeader active={sortKey === "totalCount"} column="totalCount" direction={sortDirection} label="Total jobs" onSort={sort} />
            <SortHeader active={sortKey === "totalAmount"} column="totalAmount" direction={sortDirection} label="Total amount" onSort={sort} />
          </tr></thead>
          <tbody>
            {sortedStations.map((station) => {
              const open = expanded === station.id;
              const hasActivity = Boolean(station.totalCount || station.cashbookVanCount);
              return <Fragment key={station.id}>
                <tr className={`${hasActivity ? "has-activity" : "no-activity"} ${open ? "expanded" : ""}`.trim()}>
                  <td><button className="cps-adhoc-station-button" disabled={!hasActivity} onClick={() => { setExpanded(open ? null : station.id); setExpandedDay(null); }} type="button"><span><strong>{station.code}</strong><small>{station.name} · {station.cluster}</small></span>{hasActivity ? <ChevronDown aria-hidden="true" size={15} /> : null}</button></td>
                  <td><strong>{station.vanCount}</strong></td>
                  <td><span className="cps-adhoc-amount-source">{money(station.vanAmount)}{station.cashbookVanCount ? <small>Cashbook {money(station.cashbookVanAmount)}</small> : null}</span></td>
                  <td><strong>{station.daCount}</strong></td>
                  <td>{money(station.daAmount)}</td>
                  <td><strong>{station.totalCount}</strong></td>
                  <td><strong>{money(station.totalAmount)}</strong></td>
                </tr>
                {open ? <tr className="cps-adhoc-day-row"><td colSpan={7}>
                  <div className="cps-adhoc-day-panel">
                    <header><strong>{station.code} · day-level activity</strong><span>{station.days.length} active day{station.days.length === 1 ? "" : "s"}</span></header>
                    <div className="cps-adhoc-day-grid cps-adhoc-day-grid-head"><span>Date</span><span>Van</span><span>Van amount</span><span>Cashbook paid</span><span>DA</span><span>DA amount</span><span>Total</span></div>
                    {station.days.map((day) => {
                      const key = `${station.id}:${day.date}`;
                      const dayOpen = expandedDay === key;
                      return <Fragment key={day.date}>
                        <button aria-expanded={dayOpen} className={`cps-adhoc-day-grid cps-adhoc-day-toggle ${dayOpen ? "open" : ""}`} onClick={() => setExpandedDay(dayOpen ? null : key)} type="button">
                          <strong><ChevronDown aria-hidden="true" size={13} />{dateLabel(day.date)}</strong><span>{day.vanCount}</span><span>{money(day.vanAmount)}</span><span>{day.cashbookVanCount ? `${day.cashbookVanCount} · ${money(day.cashbookVanAmount)}` : "—"}</span><span>{day.daCount}</span><span>{money(day.daAmount)}</span><strong>{day.totalCount} · {money(day.totalAmount)}</strong>
                        </button>
                        {dayOpen ? <div className="cps-adhoc-entry-panel">
                          <div className="cps-adhoc-entry-grid cps-adhoc-entry-head"><span>Source / reference</span><span>Type</span><span>Amount</span><span>Reason</span><span>Remark</span></div>
                          {day.entries.map((entry) => <div className="cps-adhoc-entry-grid" key={`${entry.source}:${entry.id}`}>
                            <span><strong>{entry.source}</strong><small>{entry.reference}{entry.countedInTotal ? "" : " · linked, not counted twice"}</small></span>
                            <strong>{entry.category}</strong>
                            <strong>{money(entry.amount)}</strong>
                            <span>{entry.reason}</span>
                            <span>{entry.remark}</span>
                          </div>)}
                          {!day.entries.length ? <p>No request details were recorded for this day.</p> : null}
                        </div> : null}
                      </Fragment>;
                    })}
                  </div>
                </td></tr> : null}
              </Fragment>;
            })}
            {!stations.length ? <tr><td className="empty-cell" colSpan={7}>No permitted stations match the selected filters.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

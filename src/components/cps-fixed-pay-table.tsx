"use client";

import { ReportTable } from "@/components/report-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Download } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { FixedPayDaStation } from "@/lib/ops-pulse/fixed-pay-da-math";
import {
  sortFixedPayDaStations,
  type FixedPayDaSortDirection,
  type FixedPayDaSortKey
} from "@/lib/ops-pulse/fixed-pay-da-sort";

function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function cpsLabel(value: number | null) {
  return value == null ? "—" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata"
  }).format(new Date(`${value}T12:00:00+05:30`));
}

function SortHeader({
  active,
  column,
  direction,
  label,
  onSort
}: {
  active: boolean;
  column: FixedPayDaSortKey;
  direction: FixedPayDaSortDirection;
  label: string;
  onSort: (column: FixedPayDaSortKey) => void;
}) {
  return (
    <th aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button className="cps-adhoc-sort" onClick={() => onSort(column)} type="button">
        <span>{label}</span>
        {active ? (
          direction === "asc" ? <ArrowUp aria-hidden="true" size={12} /> : <ArrowDown aria-hidden="true" size={12} />
        ) : (
          <ArrowUpDown aria-hidden="true" size={12} />
        )}
      </button>
    </th>
  );
}

export function CpsFixedPayTable({
  stations,
  reportParams
}: {
  stations: FixedPayDaStation[];
  reportParams: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<FixedPayDaSortKey>("salary");
  const [sortDirection, setSortDirection] = useState<FixedPayDaSortDirection>("desc");
  const sortedStations = useMemo(
    () => sortFixedPayDaStations(stations, sortKey, sortDirection),
    [stations, sortDirection, sortKey]
  );
  const sort = (column: FixedPayDaSortKey) => {
    if (column === sortKey) setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortKey(column);
      setSortDirection(column === "station" ? "asc" : "desc");
    }
  };
  const exportUrl = `/api/ops-pulse/cps/fixed-pay-da/report?${reportParams}&sort=${sortKey}&direction=${sortDirection}`;

  return (
    <>
      <div className="cps-adhoc-table-tools">
        <span>Click any heading to sort. Click a station for day-level Fixed Pay DA detail.</span>
        <a className="button secondary cps-adhoc-download" href={exportUrl}>
          <Download aria-hidden="true" size={14} /> Download Excel
        </a>
      </div>
      <div className="table-wrap cps-adhoc-table-wrap">
        <ReportTable className="cps-adhoc-table">
          <thead>
            <tr>
              <SortHeader active={sortKey === "station"} column="station" direction={sortDirection} label="Station" onSort={sort} />
              <SortHeader active={sortKey === "associates"} column="associates" direction={sortDirection} label="Fixed-pay DAs" onSort={sort} />
              <SortHeader active={sortKey === "workedDays"} column="workedDays" direction={sortDirection} label="Worked days" onSort={sort} />
              <SortHeader active={sortKey === "shipments"} column="shipments" direction={sortDirection} label="Their shipments" onSort={sort} />
              <SortHeader active={sortKey === "salary"} column="salary" direction={sortDirection} label="Fixed / MG" onSort={sort} />
              <SortHeader active={sortKey === "cps"} column="cps" direction={sortDirection} label="Fixed Pay DA CPS" onSort={sort} />
              <SortHeader active={sortKey === "pendingDays"} column="pendingDays" direction={sortDirection} label="Pending days" onSort={sort} />
            </tr>
          </thead>
          <tbody>
            {sortedStations.map((station) => {
              const open = expanded === station.code;
              return (
                <Fragment key={station.code}>
                  <tr className={open ? "expanded" : undefined}>
                    <td>
                      <button
                        className="cps-adhoc-expand"
                        onClick={() => {
                          setExpanded(open ? null : station.code);
                          setExpandedDay(null);
                        }}
                        type="button"
                      >
                        <ChevronDown aria-hidden="true" className={open ? "open" : undefined} size={14} />
                        <span>
                          <strong>{station.code}</strong>
                          <small>
                            {station.name} · {station.cluster}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>{station.associates.toLocaleString("en-IN")}</td>
                    <td>{station.workedDays.toLocaleString("en-IN")}</td>
                    <td>{station.shipments.toLocaleString("en-IN")}</td>
                    <td>{money(station.salary)}</td>
                    <td>{cpsLabel(station.cps)}</td>
                    <td>{station.pendingDays.toLocaleString("en-IN")}</td>
                  </tr>
                  {open ? (
                    <tr className="cps-adhoc-detail-row">
                      <td colSpan={7}>
                        <div className="cps-adhoc-day-list" aria-label="day-level activity">
                          {!station.days.length ? (
                            <p className="subtle">No Fixed Pay DA cost in this range.</p>
                          ) : (
                            station.days.map((day) => {
                              const dayOpen = expandedDay === `${station.code}:${day.date}`;
                              return (
                                <div className="cps-adhoc-day" key={day.date}>
                                  <button
                                    className="cps-adhoc-day-toggle"
                                    onClick={() =>
                                      setExpandedDay(dayOpen ? null : `${station.code}:${day.date}`)
                                    }
                                    type="button"
                                  >
                                    <strong>{dateLabel(day.date)}</strong>
                                    <span>
                                      {day.associates} DA · {money(day.salary)} · CPS {cpsLabel(day.cps)}
                                      {day.pendingDays ? ` · ${day.pendingDays} pending` : ""}
                                    </span>
                                  </button>
                                  {dayOpen ? (
                                    <ul>
                                      {day.people.map((person) => (
                                        <li key={`${person.workerId}-${day.date}`}>
                                          <strong>{person.name}</strong>
                                          <span>
                                            {person.dropxId || "—"} · {money(person.salary)} ·{" "}
                                            {person.shipments.toLocaleString("en-IN")} shipments
                                            {person.pendingFixedDates.length ? " · pending attendance" : ""}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  ) : null}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </ReportTable>
      </div>
    </>
  );
}

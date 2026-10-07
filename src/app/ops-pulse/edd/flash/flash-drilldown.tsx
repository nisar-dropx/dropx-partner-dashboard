"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, ChevronRight, Package, Search, Store, User } from "lucide-react";
import { FLASH_KIND_LABELS, flashDriverLabel, flashParcelMatches, flashParcelPosition, type FlashDriver, type FlashKind, type FlashParcel } from "@/lib/ops-pulse/load-flash-scope";
import s from "./flash.module.css";

const PAGE_SIZE = 50;
const count = (value: number) => value.toLocaleString("en-IN");

type DriverSort = "name" | "parcels" | "deliveredPct" | "onRoad" | "atStation" | "returns";
const DRIVER_SORT: Record<DriverSort, (driver: FlashDriver) => string | number> = {
  name: (driver) => flashDriverLabel(driver).toLowerCase(),
  parcels: (driver) => driver.parcels,
  deliveredPct: (driver) => driver.delivered + driver.onRoad ? driver.deliveredPct : -1,
  onRoad: (driver) => driver.onRoad,
  atStation: (driver) => driver.atStation,
  returns: (driver) => driver.returns
};

/**
 * The station's drivers for the day. Opening one narrows the whole report to
 * that driver and shows their tracking IDs. Stock that is not with any driver
 * is one line at the bottom, not a row per unknown handler ID.
 */
export function FlashDrivers({ drivers, onOpen, state }: {
  drivers: FlashDriver[];
  onOpen: (driverId: string) => void;
  state: "loading" | "error" | "ready";
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<DriverSort>("parcels");
  const [sortDesc, setSortDesc] = useState(true);
  const people = useMemo(() => drivers.filter((driver) => driver.driverId), [drivers]);
  const unassigned = drivers.find((driver) => !driver.driverId) ?? null;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const value = DRIVER_SORT[sortKey];
    return people
      .filter((driver) => !needle || flashDriverLabel(driver).toLowerCase().includes(needle) || driver.driverId.toLowerCase().includes(needle))
      .sort((a, b) => {
        const av = value(a), bv = value(b);
        const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return (sortDesc ? -compared : compared) || flashDriverLabel(a).localeCompare(flashDriverLabel(b));
      });
  }, [people, query, sortKey, sortDesc]);

  if (state === "loading") return <div className={s.skeletonRows} role="status" aria-label="Loading drivers">{Array.from({ length: 6 }, (_, index) => <span key={index} className={s.skeleton} />)}</div>;
  if (state === "error") return <p className={s.empty}>This station’s drivers could not be loaded. Try selecting the station again.</p>;
  if (!drivers.length) return <p className={s.empty}>No parcels are recorded for this station on this date.</p>;

  const sortBy = (key: DriverSort) => {
    if (key === sortKey) setSortDesc((current) => !current);
    else { setSortKey(key); setSortDesc(key !== "name"); }
  };
  const header = (key: DriverSort, label: string, numeric = true) => (
    <th scope="col" className={numeric ? s.num : undefined} aria-sort={sortKey === key ? (sortDesc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => sortBy(key)}>{label}{sortKey === key ? (sortDesc ? <ArrowDown size={12} /> : <ArrowUp size={12} />) : <ArrowUpDown size={12} />}</button>
    </th>
  );
  const active = people.filter((driver) => driver.delivered + driver.onRoad > 0).length;

  return (
    <>
      <div className={s.driverBar}>
        <p><b>{count(active)}</b> dispatched today{people.length > active ? <> · <b>{count(people.length - active)}</b> with stock only</> : null}{unassigned ? <> · <b>{count(unassigned.parcels)}</b> parcels not with a driver</> : null}</p>
        {people.length > 8 ? <label className={s.search}><Search size={14} /><span className={s.srOnly}>Search driver</span><input type="search" placeholder="Search driver" value={query} onChange={(event) => setQuery(event.target.value)} /></label> : null}
      </div>
      {!people.length ? <p className={s.note}>No driver is recorded against this station’s parcels yet. Drivers appear after the station’s next refresh.</p> : null}
      <div className={s.tableWrap}>
        <table className={`${s.table} ${s.fit} ${s.dense}`}>
          <thead>
            <tr>
              {header("name", "Driver", false)}
              {header("deliveredPct", "Delivered of dispatched", false)}
              {header("onRoad", "On road")}
              {header("atStation", "At station")}
              {header("returns", "Returns")}
              {header("parcels", "Parcels")}
            </tr>
          </thead>
          <tbody>
            {rows.map((driver) => {
              const dispatched = driver.delivered + driver.onRoad;
              const label = flashDriverLabel(driver);
              return (
                <tr key={driver.driverId} className={s.clickable} onClick={() => onOpen(driver.driverId)}>
                  <th scope="row">
                    <button type="button" className={s.rowButton} onClick={(event) => { event.stopPropagation(); onOpen(driver.driverId); }} title={label === driver.driverId ? `${label} is not in the workforce roster or this station's Amazon driver list` : `Open ${label}: tracking IDs`}>
                      <span className={s.avatar}>{driver.isAccessPoint ? <Store size={12} /> : <User size={12} />}</span>
                      <span><strong>{label}</strong><small>{driver.isAccessPoint ? "Store / locker" : label === driver.driverId ? "Name not found" : driver.driverId}</small></span>
                      <ChevronRight size={14} className={s.chevron} />
                    </button>
                  </th>
                  <td>
                    {dispatched ? (
                      <div className={s.delivery}>
                        <strong>{driver.deliveredPct}%</strong>
                        <div className={s.track}><span style={{ width: `${Math.min(100, driver.deliveredPct)}%` }} /></div>
                        <span>{count(driver.delivered)} / {count(dispatched)}</span>
                      </div>
                    ) : <span className={s.zero}>Nothing dispatched</span>}
                  </td>
                  <td className={s.num}>{driver.onRoad ? <span className={s.pill}>{count(driver.onRoad)}</span> : <span className={s.zero}>0</span>}</td>
                  <td className={s.num}>{driver.atStation ? count(driver.atStation) : <span className={s.zero}>0</span>}</td>
                  <td className={s.num}>{driver.returns ? count(driver.returns) : <span className={s.zero}>0</span>}</td>
                  <td className={s.num}>{count(driver.parcels)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {people.length && !rows.length ? <p className={s.empty}>No driver matches “{query}”.</p> : null}
      {unassigned ? (
        <button type="button" className={s.unassigned} onClick={() => onOpen("")}>
          <span className={s.avatar}><Package size={12} /></span>
          <span><strong>Not with a driver</strong><small>{count(unassigned.atStation)} at station{unassigned.returns ? ` · ${count(unassigned.returns)} returns` : ""}{unassigned.pickups ? ` · ${count(unassigned.pickups)} pickups` : ""}</small></span>
          <b>{count(unassigned.parcels)} parcels</b>
          <ChevronRight size={14} className={s.chevron} />
        </button>
      ) : null}
    </>
  );
}

/** One driver's tracking IDs (or the station's stock that is not with a driver), one row per parcel. */
export function FlashParcels({ parcels, title, subtitle, onBack, showHandler = false }: {
  parcels: FlashParcel[];
  title: string;
  subtitle: string;
  onBack: () => void;
  /** For stock not with a driver: show Amazon's last-handler ID instead. */
  showHandler?: boolean;
}) {
  const [kind, setKind] = useState<FlashKind | "all">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [parcels, kind, query]);

  const kindCounts = useMemo(() => Object.fromEntries((Object.keys(FLASH_KIND_LABELS) as FlashKind[]).map((key) => [key, parcels.filter((parcel) => flashParcelMatches(parcel, key)).length])) as Record<FlashKind, number>, [parcels]);
  const rows = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return parcels
      .filter((parcel) => (kind === "all" || flashParcelMatches(parcel, kind)) && (!needle || parcel.trackingId.toUpperCase().includes(needle)))
      .sort((a, b) => a.trackingId.localeCompare(b.trackingId));
  }, [parcels, kind, query]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <>
      <header className={s.panelHead}>
        <div className={s.parcelTitle}>
          <button type="button" className={s.back} onClick={onBack}><ArrowLeft size={14} /> All drivers</button>
          <div><h3>{title}</h3><span>{subtitle}</span></div>
        </div>
        <label className={s.search}><Search size={14} /><span className={s.srOnly}>Search tracking ID</span><input type="search" placeholder="Search tracking ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      </header>
      <div className={`${s.chips} ${s.chipRow}`} role="group" aria-label="Show tracking IDs">
        <button type="button" aria-pressed={kind === "all"} onClick={() => setKind("all")}>All<b>{count(parcels.length)}</b></button>
        {(Object.keys(FLASH_KIND_LABELS) as FlashKind[]).filter((key) => kindCounts[key] > 0).map((key) => (
          <button key={key} type="button" aria-pressed={kind === key} onClick={() => setKind(key)}>{FLASH_KIND_LABELS[key]}<b>{count(kindCounts[key])}</b></button>
        ))}
      </div>
      <div className={s.tableWrap}>
        <table className={`${s.table} ${s.dense}`}>
          <thead>
            <tr>
              <th scope="col">Tracking ID</th>
              <th scope="col">Position</th>
              <th scope="col">Amazon status</th>
              <th scope="col">EDD</th>
              {showHandler ? <th scope="col">Last handler ID</th> : null}
              <th scope="col">Morning list</th>
              <th scope="col">Also in</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((parcel) => {
              const position = flashParcelPosition(parcel);
              return (
                <tr key={parcel.trackingId}>
                  <th scope="row"><code className={s.tid}>{parcel.trackingId}</code></th>
                  <td><span className={`${s.tag} ${position === "Delivered" ? s.tagGood : position === "Out on road" ? s.tagInfo : ""}`}>{position}</span></td>
                  <td>{parcel.state || <span className={s.zero}>—</span>}</td>
                  <td>{parcel.edd || <span className={s.zero}>—</span>}</td>
                  {showHandler ? <td>{parcel.handlerId ? <code className={s.tid}>{parcel.handlerId}</code> : <span className={s.zero}>—</span>}</td> : null}
                  <td>{parcel.morning ? "Yes" : <span className={s.zero}>No</span>}</td>
                  <td className={s.muted}>{parcel.buckets.filter((bucket) => !position.startsWith(bucket) && !(position.startsWith("At station") && (bucket === "Inducted" || bucket === "Retained"))).join(", ") || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!rows.length ? <p className={s.empty}>No tracking IDs match.</p> : null}
      {rows.length > PAGE_SIZE ? (
        <footer className={s.pager}>
          <span>{count((current - 1) * PAGE_SIZE + 1)}–{count(Math.min(current * PAGE_SIZE, rows.length))} of {count(rows.length)}</span>
          <div>
            <button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous</button>
            <span>Page {current} of {pages}</span>
            <button type="button" disabled={current >= pages} onClick={() => setPage(current + 1)}>Next</button>
          </div>
        </footer>
      ) : null}
    </>
  );
}

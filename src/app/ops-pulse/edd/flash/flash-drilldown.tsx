"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Store, User } from "lucide-react";
import { FLASH_KIND_LABELS, flashDriverLabel, flashParcelMatches, flashParcelPosition, type FlashDriver, type FlashKind, type FlashParcel } from "@/lib/ops-pulse/load-flash-scope";
import s from "./flash.module.css";

const PAGE_SIZE = 50;
const count = (value: number) => value.toLocaleString("en-IN");

/** Everyone handling this station's parcels today. Selecting a driver narrows the whole report to them. */
export function FlashDrivers({ drivers, selected, onSelect, state }: {
  drivers: FlashDriver[];
  selected: string | null;
  onSelect: (driverId: string | null) => void;
  state: "loading" | "error" | "ready";
}) {
  const named = drivers.filter((driver) => driver.driverId);
  if (state === "loading") return <div className={s.skeletonRows} role="status" aria-label="Loading drivers">{Array.from({ length: 6 }, (_, index) => <span key={index} className={s.skeleton} />)}</div>;
  if (state === "error") return <p className={s.empty}>This station’s tracking IDs could not be loaded. Try selecting the station again.</p>;
  if (!drivers.length) return <p className={s.empty}>No tracking IDs are recorded for this station on this date.</p>;
  return (
    <>
      {!named.length ? <p className={s.note}>Amazon’s driver details are not saved for this station yet. They appear after the station’s next refresh.</p> : null}
      <div className={s.tableWrap}>
        <table className={`${s.table} ${s.fit}`}>
          <thead>
            <tr>
              <th scope="col">Driver</th>
              <th scope="col" className={s.num}>Parcels</th>
              <th scope="col">Delivered of dispatched</th>
              <th scope="col" className={s.num}>On road</th>
              <th scope="col" className={s.num}>At station</th>
              <th scope="col" className={s.num}>Returns</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((driver) => {
              const active = selected === driver.driverId;
              const dispatched = driver.delivered + driver.onRoad;
              return (
                <tr key={driver.driverId || "none"} className={active ? s.selected : undefined}>
                  <th scope="row">
                    <button type="button" className={s.rowButton} aria-pressed={active} onClick={() => onSelect(active ? null : driver.driverId)} title={active ? "Show every driver" : "Show only this driver"}>
                      <span className={s.avatar}>{driver.isAccessPoint ? <Store size={13} /> : <User size={13} />}</span>
                      <span><strong>{flashDriverLabel(driver)}</strong>{driver.driverId && driver.driverName ? <small>{driver.isAccessPoint ? "Store / locker" : driver.driverId}</small> : null}</span>
                    </button>
                  </th>
                  <td className={s.num}>{count(driver.parcels)}</td>
                  <td>
                    {dispatched ? (
                      <div className={s.delivery}>
                        <strong>{driver.deliveredPct}%</strong>
                        <div className={s.track}><span style={{ width: `${Math.min(100, driver.deliveredPct)}%` }} /></div>
                        <span>{count(driver.delivered)} / {count(dispatched)}</span>
                      </div>
                    ) : <span className={s.zero}>Nothing dispatched</span>}
                  </td>
                  <td className={s.num}>{driver.onRoad ? count(driver.onRoad) : <span className={s.zero}>0</span>}</td>
                  <td className={s.num}>{driver.atStation ? count(driver.atStation) : <span className={s.zero}>0</span>}</td>
                  <td className={s.num}>{driver.returns ? count(driver.returns) : <span className={s.zero}>0</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Every tracking ID in the current station or driver view, one row per parcel. */
export function FlashParcels({ parcels, onSelectDriver, showDriver }: {
  parcels: FlashParcel[];
  onSelectDriver: (driverId: string) => void;
  showDriver: boolean;
}) {
  const [kind, setKind] = useState<FlashKind | "all">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [parcels, kind, query]);

  const kindCounts = useMemo(() => Object.fromEntries((Object.keys(FLASH_KIND_LABELS) as FlashKind[]).map((key) => [key, parcels.filter((parcel) => flashParcelMatches(parcel, key)).length])) as Record<FlashKind, number>, [parcels]);
  const rows = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return parcels
      .filter((parcel) => (kind === "all" || flashParcelMatches(parcel, kind)) &&
        (!needle || parcel.trackingId.toUpperCase().includes(needle) || flashDriverLabel(parcel).toUpperCase().includes(needle) || parcel.driverId.toUpperCase().includes(needle)))
      .sort((a, b) => a.trackingId.localeCompare(b.trackingId));
  }, [parcels, kind, query]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <>
      <header className={s.panelHead}>
        <h3>Tracking IDs <span className={s.countTag}>{count(rows.length)}</span></h3>
        <div className={s.chips} role="group" aria-label="Show tracking IDs">
          <button type="button" aria-pressed={kind === "all"} onClick={() => setKind("all")}>All<b>{count(parcels.length)}</b></button>
          {(Object.keys(FLASH_KIND_LABELS) as FlashKind[]).map((key) => (
            <button key={key} type="button" aria-pressed={kind === key} onClick={() => setKind(key)}>{FLASH_KIND_LABELS[key]}<b>{count(kindCounts[key])}</b></button>
          ))}
        </div>
        <label className={s.search}><Search size={14} /><span className={s.srOnly}>Search tracking ID or driver</span><input type="search" placeholder="Search tracking ID or driver" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      </header>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Tracking ID</th>
              <th scope="col">Position</th>
              <th scope="col">Amazon status</th>
              <th scope="col">EDD</th>
              {showDriver ? <th scope="col">Driver</th> : null}
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
                  {showDriver ? <td>{parcel.driverId ? <button type="button" className={s.link} onClick={() => onSelectDriver(parcel.driverId)}>{flashDriverLabel(parcel)}</button> : <span className={s.zero}>No driver recorded</span>}</td> : null}
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

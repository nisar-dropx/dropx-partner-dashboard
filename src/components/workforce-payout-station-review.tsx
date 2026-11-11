"use client";

import { useMemo, useState } from "react";
import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";
import {
  summarizeWorkforcePayoutStations,
  workforceStationReviewStatusLabel,
  type WorkforceStationReviewStatus
} from "@/lib/workforce-payout-station-review";

function money(value: number) {
  return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

const STATUS_TONE: Record<WorkforceStationReviewStatus, string> = {
  blocked: "bad",
  needs_publication: "warn",
  review_pending: "info",
  payable: "good",
  settling: "info",
  cleared: "muted"
};

/**
 * Station control plane for Workforce payouts.
 * Derives only from worksheet rows already loaded by the page so the review
 * board never adds a station fan-out or a second bank/payment query.
 */
export function WorkforcePayoutStationReview({
  rows,
  selectedStations,
  onSelectedStationsChange,
  paymentReleaseHref
}: {
  rows: WorkforcePayoutRow[];
  selectedStations: string[];
  onSelectedStationsChange: (stations: string[]) => void;
  paymentReleaseHref?: string | null;
}) {
  const [query, setQuery] = useState("");
  const stations = useMemo(() => summarizeWorkforcePayoutStations(rows), [rows]);
  const selected = new Set(selectedStations);
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return stations;
    return stations.filter((station) => station.station.toLowerCase().includes(term));
  }, [stations, query]);

  const counts = useMemo(() => {
    const next = {
      blocked: 0,
      needs_publication: 0,
      review_pending: 0,
      payable: 0,
      settling: 0,
      cleared: 0,
      balance: 0
    };
    for (const station of stations) {
      next[station.status] += 1;
      next.balance += station.balance;
    }
    return next;
  }, [stations]);

  if (!stations.length) return null;

  function toggle(stationName: string) {
    onSelectedStationsChange(
      selected.has(stationName)
        ? selectedStations.filter((value) => value !== stationName)
        : [...selectedStations, stationName]
    );
  }

  function selectByStatus(status: WorkforceStationReviewStatus) {
    const names = stations.filter((station) => station.status === status).map((station) => station.station);
    const allSelected = names.length > 0 && names.every((name) => selected.has(name));
    onSelectedStationsChange(allSelected ? [] : names);
  }

  return <section className="panel workforce-station-review" aria-labelledby="workforce-station-review-title">
    <div className="panel-head workforce-station-review-head">
      <div>
        <h2 id="workforce-station-review-title">Station review</h2>
        <p className="subtle">
          Work station by station: clear blockers, publish, then pay only the ready balance.
          {paymentReleaseHref
            ? <> Loss clearance still runs through <a href={paymentReleaseHref}>payment release review</a> before bank issue.</>
            : null}
          {" "}Finance downloads the bank file and uploads enquiry on the Finance Workforce Payouts page after stations are ready.
        </p>
      </div>
      <div className="workforce-station-review-actions">
        <label className="workforce-station-search">
          <span className="sr-only">Search stations</span>
          <input
            className="field"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search station"
          />
        </label>
        {selectedStations.length
          ? <button className="button secondary small" type="button" onClick={() => onSelectedStationsChange([])}>
              Clear station filter ({selectedStations.length})
            </button>
          : null}
      </div>
    </div>

    <div className="panel-body workforce-station-review-body">
      <ul className="workforce-station-chips" aria-label="Station readiness">
        <li><button type="button" className={`bank-chip bad${counts.blocked ? "" : " zero"}`} onClick={() => selectByStatus("blocked")}><strong>{counts.blocked}</strong><span>Needs attention</span></button></li>
        <li><button type="button" className={`bank-chip warn${counts.needs_publication ? "" : " zero"}`} onClick={() => selectByStatus("needs_publication")}><strong>{counts.needs_publication}</strong><span>Publish first</span></button></li>
        <li><button type="button" className={`bank-chip info${counts.review_pending ? "" : " zero"}`} onClick={() => selectByStatus("review_pending")}><strong>{counts.review_pending}</strong><span>Review pending</span></button></li>
        <li><button type="button" className={`bank-chip good${counts.payable ? "" : " zero"}`} onClick={() => selectByStatus("payable")}><strong>{counts.payable}</strong><span>Ready for Finance</span></button></li>
        <li><button type="button" className={`bank-chip info${counts.settling ? "" : " zero"}`} onClick={() => selectByStatus("settling")}><strong>{counts.settling}</strong><span>With bank</span></button></li>
        <li className={`bank-chip muted`} aria-label="Open station balance"><strong>{money(counts.balance)}</strong><span>Open balance</span></li>
      </ul>

      <ul className="workforce-station-grid">
        {visible.map((station) => {
          const picked = selected.has(station.station);
          return <li key={`${station.stationId ?? "none"}:${station.station}`}>
            <button
              type="button"
              className={`workforce-station-card tone-${STATUS_TONE[station.status]}${picked ? " is-picked" : ""}`}
              onClick={() => toggle(station.station)}
              aria-pressed={picked}
              title={station.blockerSample ?? workforceStationReviewStatusLabel(station.status)}
            >
              <strong>{station.station}</strong>
              <em>{workforceStationReviewStatusLabel(station.status)}</em>
              <span>{station.payableRows} payable · {station.rows} rows</span>
              <span>{money(station.balance)} balance · {money(station.paid)} paid</span>
              {station.blockedRows || station.needsPublicationRows
                ? <small>{station.blockedRows ? `${station.blockedRows} blocked` : `${station.needsPublicationRows} need publish`}</small>
                : null}
            </button>
          </li>;
        })}
      </ul>
      {!visible.length ? <p className="subtle">No station matches that search.</p> : null}
      <p className="subtle workforce-station-hint">
        Selecting stations filters the worksheet below. Approve/publish those rows first; bank download remains gated by publication freshness, loss clearance and payment eligibility.
      </p>
    </div>
  </section>;
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";
import type {
  WorkforceStationFinanceRequest,
  WorkforceStationReleaseState
} from "@/lib/workforce-payout-station-finance-types";
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

function financeLabel(request: WorkforceStationFinanceRequest | undefined, released: boolean) {
  if (!released) return null;
  if (!request) return "Confirmed · ready to send";
  if (request.changed) return "Revised · resubmit";
  if (request.status === "submitted") return "With Finance";
  if (request.status === "approved") return "Approved by Finance";
  if (request.status === "returned") return "Returned by Finance";
  return null;
}

/**
 * Station control plane for Workforce payouts.
 * Derives worksheet cards from already-loaded rows, then uses the station
 * release / Finance APIs for durable confirmation — never a per-station bank query.
 */
export function WorkforcePayoutStationReview({
  rows,
  selectedStations,
  onSelectedStationsChange,
  paymentReleaseHref,
  audience,
  periodStart,
  periodEnd,
  canConfirmStations,
  canSubmitFinance,
  canDecideFinance,
  releases,
  financeRequests
}: {
  rows: WorkforcePayoutRow[];
  selectedStations: string[];
  onSelectedStationsChange: (stations: string[]) => void;
  paymentReleaseHref?: string | null;
  audience: "workforce" | "helpers";
  periodStart: string;
  periodEnd: string;
  canConfirmStations: boolean;
  canSubmitFinance: boolean;
  canDecideFinance: boolean;
  releases: WorkforceStationReleaseState[];
  financeRequests: WorkforceStationFinanceRequest[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("");
  const stations = useMemo(() => summarizeWorkforcePayoutStations(rows), [rows]);
  const releaseByStation = useMemo(() => new Map(releases.map((row) => [row.stationId.toLowerCase(), row])), [releases]);
  const requestByStation = useMemo(() => new Map(financeRequests.map((row) => [row.stationId.toLowerCase(), row])), [financeRequests]);
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
      confirmed: 0,
      withFinance: 0,
      balance: 0
    };
    for (const station of stations) {
      next[station.status] += 1;
      next.balance += station.balance;
      const stationId = station.stationId?.toLowerCase();
      if (stationId && releaseByStation.has(stationId)) next.confirmed += 1;
      const request = stationId ? requestByStation.get(stationId) : undefined;
      if (request?.status === "submitted" || request?.status === "approved") next.withFinance += 1;
    }
    return next;
  }, [stations, releaseByStation, requestByStation]);

  if (!stations.length) return null;

  function toggleFilter(stationName: string) {
    onSelectedStationsChange(
      selected.has(stationName)
        ? selectedStations.filter((value) => value !== stationName)
        : [...selectedStations, stationName]
    );
  }

  function togglePick(stationId: string) {
    setPickedIds((current) => current.includes(stationId)
      ? current.filter((value) => value !== stationId)
      : [...current, stationId]);
  }

  function selectByStatus(status: WorkforceStationReviewStatus) {
    const names = stations.filter((station) => station.status === status).map((station) => station.station);
    const allSelected = names.length > 0 && names.every((name) => selected.has(name));
    onSelectedStationsChange(allSelected ? [] : names);
  }

  async function postJson(url: string, body: Record<string, unknown>, pending: string) {
    setBusy(pending);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "The station workflow request failed.");
      setNotice(pending === "confirm" ? "Stations confirmed."
        : pending === "reopen" ? "Stations reopened."
          : pending === "submit" ? "Stations sent to Finance."
            : pending === "approve" ? "Finance approved the station."
              : "Finance returned the station.");
      setPickedIds([]);
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The station workflow request failed.");
    } finally {
      setBusy("");
    }
  }

  const confirmable = stations.filter((station) => station.stationId
    && !releaseByStation.has(station.stationId.toLowerCase())
    && station.status !== "blocked"
    && station.status !== "needs_publication"
    && (station.payableRows > 0 || station.reviewRows > 0 || station.settlingRows > 0 || station.status === "cleared"));
  const reopenable = releases.filter((row) => row.canReopen);
  const submittable = releases.filter((row) => {
    const request = requestByStation.get(row.stationId.toLowerCase());
    return !request || request.changed || request.status === "returned";
  });
  const decidable = financeRequests.filter((row) => row.status === "submitted" && !row.changed);

  return <section className="panel workforce-station-review" aria-labelledby="workforce-station-review-title">
    <div className="panel-head workforce-station-review-head">
      <div>
        <h2 id="workforce-station-review-title">Station review</h2>
        <p className="subtle">
          Confirm ready stations, send them to Finance, then download the bank file and upload enquiry on Finance.
          {paymentReleaseHref
            ? <> Loss clearance still runs through <a href={paymentReleaseHref}>payment release review</a>.</>
            : null}
        </p>
      </div>
      <div className="workforce-station-review-actions">
        <label className="workforce-station-search">
          <span className="sr-only">Search stations</span>
          <input className="field" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search station" />
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
        <li><button type="button" className={`bank-chip good${counts.payable ? "" : " zero"}`} onClick={() => selectByStatus("payable")}><strong>{counts.payable}</strong><span>Ready</span></button></li>
        <li className="bank-chip info"><strong>{counts.confirmed}</strong><span>Confirmed</span></li>
        <li className="bank-chip info"><strong>{counts.withFinance}</strong><span>With Finance</span></li>
        <li className="bank-chip muted" aria-label="Open station balance"><strong>{money(counts.balance)}</strong><span>Open balance</span></li>
      </ul>

      {(canConfirmStations || canSubmitFinance || canDecideFinance) && (confirmable.length || reopenable.length || submittable.length || decidable.length)
        ? <div className="workforce-station-workflow">
            {canConfirmStations ? <div className="inline-actions">
              <button className="button secondary small" type="button" disabled={!!busy}
                onClick={() => setPickedIds(confirmable.flatMap((station) => station.stationId ? [station.stationId] : []))}>
                Select confirmable
              </button>
              <button className="button primary" type="button" disabled={!!busy || !pickedIds.length}
                onClick={() => postJson("/api/payments/workforce-payouts/station-releases", {
                  action: "confirm", audience, periodStart, periodEnd, stationIds: pickedIds
                }, "confirm")}>
                {busy === "confirm" ? "Confirming…" : pickedIds.length ? `Confirm ${pickedIds.length} station${pickedIds.length === 1 ? "" : "s"}` : "Confirm stations"}
              </button>
              {reopenable.length ? <button className="button secondary" type="button" disabled={!!busy || !pickedIds.length}
                onClick={() => postJson("/api/payments/workforce-payouts/station-releases", {
                  action: "reopen", audience, periodStart, periodEnd, stationIds: pickedIds
                }, "reopen")}>
                {busy === "reopen" ? "Reopening…" : "Reopen selected"}
              </button> : null}
            </div> : null}
            {canSubmitFinance ? <div className="inline-actions">
              <button className="button secondary small" type="button" disabled={!!busy}
                onClick={() => setPickedIds(submittable.map((row) => row.stationId))}>
                Select for Finance
              </button>
              <button className="button primary" type="button" disabled={!!busy || !pickedIds.length}
                onClick={() => postJson("/api/payments/workforce-payouts/finance", {
                  action: "submit", audience, periodStart, periodEnd, stationIds: pickedIds
                }, "submit")}>
                {busy === "submit" ? "Sending…" : "Send to Finance"}
              </button>
            </div> : null}
            {canDecideFinance && decidable.length ? <div className="workforce-station-finance-decide">
              <label>Finance review reason
                <input className="field" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="At least 10 characters" />
              </label>
              <div className="inline-actions">
                <button className="button secondary small" type="button" disabled={!!busy}
                  onClick={() => setPickedIds(decidable.map((row) => row.stationId))}>
                  Select submitted
                </button>
                <button className="button primary" type="button" disabled={!!busy || reason.trim().length < 10 || !pickedIds.length}
                  onClick={async () => {
                    for (const request of decidable.filter((row) => pickedIds.includes(row.stationId))) {
                      await postJson("/api/payments/workforce-payouts/finance", {
                        action: "approve", requestId: request.id, version: request.version, reason
                      }, "approve");
                    }
                  }}>
                  {busy === "approve" ? "Approving…" : "Approve for payment"}
                </button>
                <button className="button secondary" type="button" disabled={!!busy || reason.trim().length < 10 || !pickedIds.length}
                  onClick={async () => {
                    for (const request of decidable.filter((row) => pickedIds.includes(row.stationId))) {
                      await postJson("/api/payments/workforce-payouts/finance", {
                        action: "return", requestId: request.id, version: request.version, reason
                      }, "return");
                    }
                  }}>
                  {busy === "return" ? "Returning…" : "Return to Ops"}
                </button>
              </div>
            </div> : null}
          </div>
        : null}

      {error ? <div className="payout-inline-message error" role="alert">{error}</div> : null}
      {notice ? <div className="payout-inline-message success" role="status">{notice}</div> : null}

      <ul className="workforce-station-grid">
        {visible.map((station) => {
          const pickedFilter = selected.has(station.station);
          const stationId = station.stationId;
          const release = stationId ? releaseByStation.get(stationId.toLowerCase()) : undefined;
          const request = stationId ? requestByStation.get(stationId.toLowerCase()) : undefined;
          const pickedWorkflow = stationId ? pickedIds.includes(stationId) : false;
          const handoff = financeLabel(request, Boolean(release));
          return <li key={`${station.stationId ?? "none"}:${station.station}`}>
            <div className={`workforce-station-card tone-${STATUS_TONE[station.status]}${pickedFilter || pickedWorkflow ? " is-picked" : ""}${release ? " is-released" : ""}`}>
              {stationId && (canConfirmStations || canSubmitFinance || canDecideFinance)
                ? <label className="workforce-station-pick">
                    <input type="checkbox" checked={pickedWorkflow} onChange={() => togglePick(stationId)} />
                    <span className="sr-only">Select {station.station}</span>
                  </label>
                : null}
              <button type="button" className="workforce-station-card-main" onClick={() => toggleFilter(station.station)} aria-pressed={pickedFilter}
                title={station.blockerSample ?? workforceStationReviewStatusLabel(station.status)}>
                <strong>{station.station}</strong>
                <em>{handoff || workforceStationReviewStatusLabel(station.status)}</em>
                <span>{station.payableRows} payable · {station.rows} rows</span>
                <span>{money(station.balance)} balance · {money(station.paid)} paid</span>
                {station.blockedRows || station.needsPublicationRows
                  ? <small>{station.blockedRows ? `${station.blockedRows} blocked` : `${station.needsPublicationRows} need publish`}</small>
                  : null}
              </button>
            </div>
          </li>;
        })}
      </ul>
      {!visible.length ? <p className="subtle">No station matches that search.</p> : null}
      <p className="subtle workforce-station-hint">
        Card click filters the worksheet. Checkboxes drive Confirm / Send to Finance / Finance approve. Bank download stays on Finance after approval, loss clearance and publication freshness checks.
      </p>
    </div>
  </section>;
}

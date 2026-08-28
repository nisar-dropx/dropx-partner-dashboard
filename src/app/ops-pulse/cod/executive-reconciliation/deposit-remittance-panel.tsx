"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  LiabilitySummaryNormalized,
  RemittanceLedgerDay,
  RemittanceRowNormalized,
  RemittanceSummaryNormalized
} from "@/lib/ops-pulse/cash-recon-types";
import { submitCodDayClosure, validateCodRemittanceDeposit } from "./actions";

const SHORT_BLOCK_RUPEES = 10;
const VALIDATE_COOLDOWN_MS = 10_000;
const MATCH_EPSILON = 0.01;
// Small change/rounding variance is auto-validated without remarks; only a difference beyond this needs an explanation.
const DIFFERENCE_REMARKS_RUPEES = 5;

function currency(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Formats INR with the sign before the rupee symbol: -₹26.00 */
function money(value: number) {
  const absolute = currency(Math.abs(value));
  if (Math.abs(value) < MATCH_EPSILON) return `₹${absolute}`;
  return value < 0 ? `-₹${absolute}` : `₹${absolute}`;
}

function matchModeLabel(mode: string | null | undefined) {
  const normalized = String(mode ?? "").trim();
  if (!normalized) return "From remittance summary";
  if (normalized === "sameDay") return "Same-day match";
  if (normalized === "window") return "Window match";
  return normalized.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase());
}

function matchStatusLabel(status: string | null | undefined) {
  const normalized = String(status ?? "").trim();
  if (!normalized) return "—";
  if (normalized === "MATCHED") return "Matched";
  if (normalized === "MISMATCH") return "Mismatch";
  return normalized.replace(/_/g, " ").toLowerCase().replace(/^./, (char) => char.toUpperCase());
}

function formatEpoch(ms: number | null) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function formatDateLabel(date: string) {
  if (!date) return "—";
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function toneForAmount(value: number) {
  if (Math.abs(value) < MATCH_EPSILON) return "neutral";
  return value > 0 ? "short" : "excess";
}

function ledgerDayStatus(day: RemittanceLedgerDay): "pending" | "forwarded" | "cleared" {
  if (day.stillPendingAmount > MATCH_EPSILON) return "pending";
  if (day.forwardedAmount > MATCH_EPSILON || day.drivers.length > 0) return "forwarded";
  return "cleared";
}

function ledgerDayStatusLabel(status: "pending" | "forwarded" | "cleared") {
  if (status === "pending") return "Pending";
  if (status === "forwarded") return "Forwarded";
  return "Cleared";
}

function ledgerDayStatusTone(status: "pending" | "forwarded" | "cleared") {
  if (status === "pending") return "danger";
  if (status === "forwarded") return "warn";
  return "good";
}

function RemittanceRowsTable({
  title,
  meta,
  rows,
  emptyLabel
}: {
  title: string;
  meta: string;
  rows: RemittanceRowNormalized[];
  emptyLabel: string;
}) {
  return (
    <div className="remittance-table-block">
      <div className="remittance-table-head">
        <div>
          <strong>{title}</strong>
          <span>{meta}</span>
        </div>
        <em>{rows.length}</em>
      </div>
      <div className="table-wrap remittance-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Created</th>
              <th>Submitted</th>
              <th>Expected</th>
              <th>Actual</th>
              <th>Variance</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={`${row.remittanceId || row.remittanceCode}-${row.creationDate ?? 0}-${row.status}`}>
                <td>
                  <strong>{row.remittanceCode || "—"}</strong>
                  {row.remittanceId ? <small className="remittance-id">{row.remittanceId}</small> : null}
                </td>
                <td><span className="remittance-chip">{row.status}</span></td>
                <td>{formatEpoch(row.creationDate)}</td>
                <td>{formatEpoch(row.submissionDate)}</td>
                <td>{money(row.expectedAmount)}</td>
                <td>{money(row.actualAmount)}</td>
                <td className={`amount-tone ${toneForAmount(row.variance)}`}>{money(row.variance)}</td>
              </tr>
            )) : (
              <tr><td className="empty-cell" colSpan={7}>{emptyLabel}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LedgerDayCard({
  day,
  onOpen
}: {
  day: RemittanceLedgerDay;
  onOpen: (date: string) => void;
}) {
  const status = ledgerDayStatus(day);
  return (
    <button
      type="button"
      className={`remittance-day-card ${status}`}
      onClick={() => onOpen(day.date)}
    >
      <div>
        <div className="remittance-day-card-title">
          <strong>{formatDateLabel(day.date)}</strong>
          <span className={`remittance-status-pill ${ledgerDayStatusTone(status)}`}>{ledgerDayStatusLabel(status)}</span>
        </div>
        <span>Expected {money(day.expectedCashTotal)} · Remittance {money(day.remittanceTotalCash)}</span>
      </div>
      <div className="remittance-day-metrics">
        <span className={toneForAmount(day.shortAmount)}>Short {money(day.shortAmount)}</span>
        <span>Pending {money(day.stillPendingAmount)}</span>
        <span>Forwarded {money(day.forwardedAmount)}</span>
        <em>View day →</em>
      </div>
    </button>
  );
}

function LedgerModal({
  stationCode,
  businessDate,
  remittance,
  onClose
}: {
  stationCode: string;
  businessDate: string;
  remittance: RemittanceSummaryNormalized;
  onClose: () => void;
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const summary = remittance.matchSummary;
  const ledger = remittance.ledger;
  const selectedDay = ledger.find((day) => day.date === selectedDate) ?? null;
  const openDays = ledger.filter((day) => ledgerDayStatus(day) !== "cleared");
  const clearedDays = ledger.filter((day) => ledgerDayStatus(day) === "cleared");
  const overallClear = Boolean(summary && summary.finalPendingTotal <= MATCH_EPSILON && summary.sameDayShortAmount <= MATCH_EPSILON) || (!summary && openDays.length === 0);
  const selectedDayStatus = selectedDay ? ledgerDayStatus(selectedDay) : null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel remittance-ledger-modal" role="dialog" aria-modal="true" aria-labelledby="ledger-title">
        <div className="panel-head">
          <div>
            <h2 id="ledger-title">{selectedDay ? `Ledger · ${formatDateLabel(selectedDay.date)}` : "Pending cash ledger"}</h2>
            <p className="subtle">
              {stationCode} · business date {businessDate}
              {summary?.windowFrom && summary?.windowTo ? ` · window ${summary.windowFrom} → ${summary.windowTo}` : ""}
              {!selectedDay ? ` · ${ledger.length} day${ledger.length === 1 ? "" : "s"} in ledger` : ""}
            </p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="panel-body remittance-ledger-body">
          {selectedDay ? (
            <>
              <div className="remittance-ledger-toolbar">
                <button className="button secondary" type="button" onClick={() => setSelectedDate(null)}>← Back to days</button>
                {selectedDayStatus ? (
                  <span className={`remittance-status-pill ${ledgerDayStatusTone(selectedDayStatus)}`}>
                    {ledgerDayStatusLabel(selectedDayStatus)}
                  </span>
                ) : null}
              </div>

              <div className="remittance-ledger-section">
                <h4 className="remittance-ledger-section-title">Opening &amp; expected</h4>
                <div className="remittance-kpi-grid compact">
                  <div className="remittance-kpi">
                    <span>Carry-in</span><strong>₹{currency(selectedDay.carryForwardIn)}</strong><small>Opening balance</small>
                  </div>
                  <div className="remittance-kpi">
                    <span>Expected</span><strong>₹{currency(selectedDay.expectedCashTotal)}</strong>
                  </div>
                  <div className="remittance-kpi">
                    <span>Remittance</span><strong>₹{currency(selectedDay.remittanceTotalCash)}</strong>
                  </div>
                  <div className={`remittance-kpi ${toneForAmount(selectedDay.shortAmount)}`}>
                    <span>Short / excess</span><strong>₹{currency(selectedDay.shortAmount)}</strong>
                  </div>
                </div>
              </div>

              <div className="remittance-ledger-section">
                <h4 className="remittance-ledger-section-title">Clearance &amp; closing</h4>
                <div className="remittance-kpi-grid compact">
                  <div className="remittance-kpi">
                    <span>Cleared same day</span><strong>₹{currency(selectedDay.clearedSameDayAmount)}</strong>
                  </div>
                  <div className="remittance-kpi">
                    <span>Cleared from prior</span><strong>₹{currency(selectedDay.clearedFromPriorAmount)}</strong>
                  </div>
                  <div className={`remittance-kpi ${selectedDay.forwardedAmount > MATCH_EPSILON ? "warn" : ""}`}>
                    <span>Forwarded</span><strong>₹{currency(selectedDay.forwardedAmount)}</strong>
                  </div>
                  <div className={`remittance-kpi ${selectedDay.stillPendingAmount > MATCH_EPSILON ? "short" : ""}`}>
                    <span>Still pending</span><strong>₹{currency(selectedDay.stillPendingAmount)}</strong>
                  </div>
                  <div className="remittance-kpi primary">
                    <span>Carry-out</span><strong>₹{currency(selectedDay.carryForwardOut)}</strong><small>Closing balance</small>
                  </div>
                </div>
              </div>

              <div className="remittance-ledger-section">
                <h4 className="remittance-ledger-section-title">
                  Driver breakdown
                  {selectedDay.drivers.length ? <span className="remittance-chip">{selectedDay.drivers.length}</span> : null}
                </h4>
                {selectedDay.drivers.length ? selectedDay.drivers.map((driver) => (
                  <div className="remittance-driver-card" key={`${selectedDay.date}-${driver.tasId || driver.driverName}`}>
                    <div className="remittance-driver-head">
                      <div>
                        <strong>{driver.driverName}</strong>
                        <span>
                          {driver.tasId ? `TAS ${driver.tasId}` : "No TAS"}
                          {driver.employeeId ? ` · Emp ${driver.employeeId}` : ""}
                          {` · ${driver.shipmentCount} shipment${driver.shipmentCount === 1 ? "" : "s"}`}
                        </span>
                      </div>
                      <em>₹{currency(driver.amount)}</em>
                    </div>
                    <div className="table-wrap remittance-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Tracking</th>
                            <th>Shipment</th>
                            <th>Pending</th>
                            <th>Kept</th>
                            <th>Cleared</th>
                            <th>Days</th>
                            <th>Status</th>
                            <th>Remittance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {driver.shipments.length ? driver.shipments.map((shipment) => (
                            <tr key={`${shipment.trackingId}-${shipment.remittanceId || ""}-${shipment.pendingAmount}`}>
                              <td><strong>{shipment.trackingId}</strong></td>
                              <td>{shipment.shipmentNo || "—"}</td>
                              <td>₹{currency(shipment.pendingAmount)}</td>
                              <td>{shipment.keptOnDate || "—"}</td>
                              <td>{shipment.clearedOnDate || "—"}</td>
                              <td>{shipment.keptDays ?? "—"}</td>
                              <td>
                                <span className={`remittance-chip ${/clear/i.test(shipment.status) ? "good" : /pending|forward/i.test(shipment.status) ? "warn" : ""}`}>
                                  {shipment.status}
                                </span>
                              </td>
                              <td>{shipment.remittanceCode || "—"}</td>
                            </tr>
                          )) : (
                            <tr><td className="empty-cell" colSpan={8}>No shipment rows for this driver.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )) : (
                  <p className="subtle remittance-empty-note">No forward/pending driver detail for this day.</p>
                )}
              </div>
            </>
          ) : (
            <>
              <div className={`remittance-ledger-hero ${overallClear ? "good" : "warn"}`}>
                <div className="remittance-ledger-hero-status">
                  <strong>{overallClear ? "All cash cleared" : "Pending cash needs attention"}</strong>
                  <span>
                    {summary
                      ? `${matchModeLabel(summary.mode)} · window ${summary.windowFrom ?? "—"} → ${summary.windowTo ?? "—"}`
                      : "No match summary is available for this station and date."}
                  </span>
                </div>
                {summary ? (
                  <div className="remittance-ledger-hero-metrics">
                    <div>
                      <span>Match status</span>
                      <strong className={`remittance-status ${summary.status === "MATCHED" ? "good" : "warn"}`}>{matchStatusLabel(summary.status)}</strong>
                    </div>
                    <div>
                      <span>Final pending</span>
                      <strong>{money(summary.finalPendingTotal)}</strong>
                    </div>
                    <div>
                      <span>Same-day short</span>
                      <strong>{money(summary.sameDayShortAmount)}</strong>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="remittance-day-list">
                {openDays.length ? openDays.map((day) => (
                  <LedgerDayCard key={day.date} day={day} onOpen={setSelectedDate} />
                )) : !ledger.length ? (
                  <p className="subtle remittance-empty-note">No ledger rows for this station and date.</p>
                ) : null}
              </div>

              {clearedDays.length ? (
                <details className="remittance-cleared-days" open={!openDays.length}>
                  <summary>Cleared days ({clearedDays.length})</summary>
                  <div className="remittance-day-list">
                    {clearedDays.map((day) => (
                      <LedgerDayCard key={day.date} day={day} onOpen={setSelectedDate} />
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export function DepositRemittancePanel({
  stationCode,
  businessDate,
  locationId,
  returnHref,
  collectedCash,
  canEdit,
  driverCleared,
  isFinalSubmitted,
  depositAlreadyCleared,
  initialOverrideRemarks = ""
}: {
  stationCode: string;
  businessDate: string;
  locationId: string;
  returnHref: string;
  collectedCash: number;
  canEdit: boolean;
  driverCleared: boolean;
  isFinalSubmitted: boolean;
  depositAlreadyCleared: boolean;
  initialOverrideRemarks?: string;
}) {
  const router = useRouter();
  const validateFormRef = useRef<HTMLFormElement | null>(null);
  const [checking, setChecking] = useState(false);
  const [savingValidation, setSavingValidation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkingLiability, setCheckingLiability] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remittance, setRemittance] = useState<RemittanceSummaryNormalized | null>(null);
  const [validateRemarks, setValidateRemarks] = useState(initialOverrideRemarks);
  const [showDifferenceModal, setShowDifferenceModal] = useState(false);
  const [showLiabilityModal, setShowLiabilityModal] = useState(false);
  const [showLedgerModal, setShowLedgerModal] = useState(false);
  const [liability, setLiability] = useState<LiabilitySummaryNormalized | null>(null);
  const [depositValidated, setDepositValidated] = useState(depositAlreadyCleared);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownLeftSec, setCooldownLeftSec] = useState(0);

  useEffect(() => {
    setDepositValidated(depositAlreadyCleared);
  }, [depositAlreadyCleared]);

  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownLeftSec(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownLeftSec(left);
      if (left <= 0) setCooldownUntil(0);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  const match = remittance?.matchSummary ?? null;
  const expectedCashTotal = match?.sameDayExpectedCashTotal ?? null;
  const remittanceCash = remittance?.remittanceTotalCash ?? null;

  const pageVsRemittance = useMemo(() => {
    if (remittanceCash == null) return null;
    return Number((collectedCash - remittanceCash).toFixed(2));
  }, [collectedCash, remittanceCash]);

  const sameDayShort = match?.sameDayShortAmount ?? null;
  const isShortOverLimit = pageVsRemittance != null && pageVsRemittance < -SHORT_BLOCK_RUPEES;
  const unresolvedPending = Boolean(match && match.finalPendingTotal > MATCH_EPSILON);
  const sameDayShortBlocked = Boolean(
    match
    && match.mode === "sameDay"
    && match.sameDayShortAmount > SHORT_BLOCK_RUPEES
  );
  const expectedCashMismatch = Boolean(
    remittance
    && (
      unresolvedPending
      || sameDayShortBlocked
      || (
        !match
        && expectedCashTotal != null
        && remittanceCash != null
        && Math.abs(remittanceCash - expectedCashTotal) >= MATCH_EPSILON
      )
    )
  );
  const needsDifferenceRemarks = pageVsRemittance != null && Math.abs(pageVsRemittance) > DIFFERENCE_REMARKS_RUPEES;
  const hasPendingCreated = Boolean(remittance && remittance.createdCount > 0);
  const submitBlocked = isShortOverLimit || expectedCashMismatch;
  const validateBusy = checking || savingValidation;
  const validateOnCooldown = cooldownLeftSec > 0;
  const canValidate = canEdit && driverCleared && !isFinalSubmitted && !validateBusy && !validateOnCooldown && !submitting;
  const canSubmitFinal = canEdit
    && driverCleared
    && depositValidated
    && !isFinalSubmitted
    && !submitting
    && !validateBusy
    && !submitBlocked
    && Boolean(remittance);

  function startCooldown() {
    setCooldownUntil(Date.now() + VALIDATE_COOLDOWN_MS);
  }

  async function persistValidation(summary: RemittanceSummaryNormalized, overrideRemarks: string) {
    const form = validateFormRef.current;
    if (!form) return false;
    const ensure = (name: string, value: string) => {
      let input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!input) {
        input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        form.appendChild(input);
      }
      input.value = value;
    };
    ensure("remittance_override_remarks", overrideRemarks);
    ensure("remittance_payload", JSON.stringify(summary));
    ensure("collected_cash", String(collectedCash));
    ensure("response_mode", "client");
    setSavingValidation(true);
    try {
      const result = await validateCodRemittanceDeposit(new FormData(form));
      if (!result || !("ok" in result) || !result.ok) {
        setError((result && "error" in result ? result.error : null) || "Unable to save remittance validation.");
        setDepositValidated(false);
        return false;
      }
      setDepositValidated(true);
      setShowDifferenceModal(false);
      setNotice(result.notice || "Remittance validation saved.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save remittance validation.");
      setDepositValidated(false);
      return false;
    } finally {
      setSavingValidation(false);
    }
  }

  async function validateDeposit() {
    if (!canValidate) return;
    setError(null);
    setNotice(null);
    setShowDifferenceModal(false);
    setShowLiabilityModal(false);
    setChecking(true);
    try {
      const response = await fetch("/api/ops-pulse/cod/cash-recon/remittance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stationCode, date: businessDate })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Unable to load remittance.");
      const summary = payload as RemittanceSummaryNormalized;
      setRemittance(summary);

      const diff = Number((collectedCash - summary.remittanceTotalCash).toFixed(2));
      const shortBlocked = diff < -SHORT_BLOCK_RUPEES;
      const matchSummary = summary.matchSummary;
      const pendingBlocked = Boolean(matchSummary && matchSummary.finalPendingTotal > MATCH_EPSILON);
      const sameDayBlocked = Boolean(
        matchSummary
        && matchSummary.mode === "sameDay"
        && matchSummary.sameDayShortAmount > SHORT_BLOCK_RUPEES
      );
      const needsRemarks = (Math.abs(diff) > DIFFERENCE_REMARKS_RUPEES || summary.createdCount > 0) && !shortBlocked;

      if (shortBlocked || pendingBlocked || sameDayBlocked) {
        await persistValidation(summary, validateRemarks.trim());
      } else if (needsRemarks) {
        setDepositValidated(false);
        setShowDifferenceModal(true);
      } else {
        await persistValidation(summary, validateRemarks.trim());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to validate deposit.");
      setDepositValidated(false);
    } finally {
      setChecking(false);
      startCooldown();
    }
  }

  async function confirmDifferenceRemarks() {
    if (!remittance || !validateRemarks.trim() || savingValidation) return;
    await persistValidation(remittance, validateRemarks.trim());
  }

  async function runFinalSubmit() {
    if (submitting || !depositValidated || isFinalSubmitted || submitBlocked) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.set("return_href", returnHref);
      formData.set("business_date", businessDate);
      formData.set("location_id", locationId);
      formData.set("remittance_override_remarks", validateRemarks.trim());
      formData.set("response_mode", "client");
      const result = await submitCodDayClosure(formData);
      if (!result || !("ok" in result) || !result.ok) {
        setError((result && "error" in result ? result.error : null) || "Unable to submit COD day closure.");
        setSubmitting(false);
        return;
      }
      setShowLiabilityModal(false);
      setNotice(result.notice || "COD day closure submitted.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit COD day closure.");
      setSubmitting(false);
    }
  }

  async function openLiabilityGate() {
    if (!canSubmitFinal) {
      setError(
        !depositValidated
          ? "Validate remittance before submitting final COD closure."
          : submitBlocked
            ? "Resolve the cash short or pending remittance before submitting."
            : null
      );
      return;
    }
    setError(null);
    setCheckingLiability(true);
    setShowLiabilityModal(true);
    setLiability(null);
    try {
      const response = await fetch("/api/ops-pulse/cod/cash-recon/liability-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stationCode, date: businessDate })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Unable to check SCC liability.");
      setLiability(payload as LiabilitySummaryNormalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to check SCC liability.");
      setShowLiabilityModal(false);
    } finally {
      setCheckingLiability(false);
    }
  }

  const validateLabel = !driverCleared
    ? "Complete driver reconciliation first"
    : checking
      ? "Validating…"
      : savingValidation
        ? "Saving…"
        : validateOnCooldown
          ? `Wait ${cooldownLeftSec}s`
          : remittance
            ? "Validate again"
            : "Validate deposit";

  const matchStatus = match?.status ?? null;
  const pendingDayCount = remittance?.ledger.filter((day: RemittanceLedgerDay) =>
    day.stillPendingAmount > MATCH_EPSILON || day.forwardedAmount > MATCH_EPSILON || day.drivers.length > 0
  ).length ?? 0;

  return (
    <>
      <section className={`reconciliation-gate remittance-deposit-panel ${!driverCleared ? "locked" : ""}`}>
        <div className="reconciliation-gate-head">
          <div>
            <span>Validation 2</span>
            <strong>Bank deposit</strong>
          </div>
          <span className={`remittance-status-pill ${depositValidated ? "good" : remittance ? "warn" : ""}`}>
            {depositValidated ? "Validated" : remittance ? "Reviewed" : "Not validated"}
          </span>
        </div>

        <div className="remittance-intro">
          <p>
            Amazon SCC remittance for <strong>{stationCode}</strong> on <strong>{businessDate}</strong>.
            Collected cash on this page: <strong>{money(collectedCash)}</strong>.
            Re-validate after SCC updates. Cash entries lock only after final submission.
          </p>
          <div className="remittance-actions">
            <form ref={validateFormRef} onSubmit={(event) => event.preventDefault()}>
              <input type="hidden" name="return_href" value={returnHref} />
              <input type="hidden" name="business_date" value={businessDate} />
              <input type="hidden" name="location_id" value={locationId} />
              <input type="hidden" name="response_mode" value="client" />
              <button
                className="button secondary"
                type="button"
                disabled={!canValidate}
                onClick={() => void validateDeposit()}
              >
                {validateLabel}
              </button>
            </form>
            <button
              className="button secondary"
              type="button"
              disabled={!remittance}
              onClick={() => setShowLedgerModal(true)}
            >
              View pending cash ledger{pendingDayCount ? ` (${pendingDayCount})` : ""}
            </button>
          </div>
          {validateOnCooldown && !checking ? (
            <p className="subtle remittance-cooldown">You can validate again in {cooldownLeftSec}s</p>
          ) : null}
        </div>

        {error ? (
          <div className="alert danger remittance-alert">
            <strong>Action failed</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="alert remittance-alert">
            <strong>Update</strong>
            <span>{notice}</span>
          </div>
        ) : null}
        {submitting ? <p className="subtle">Submitting final COD closure…</p> : null}

        {remittance ? (
          <>
            <div className="remittance-kpi-grid">
              <div className="remittance-kpi primary">
                <span>Remittance total</span>
                <strong>{money(remittance.remittanceTotalCash)}</strong>
                <small>{remittance.submittedCount} submitted · {remittance.createdCount} pending creation</small>
              </div>
              <div className="remittance-kpi">
                <span>Same-day expected</span>
                <strong>{expectedCashTotal == null ? "—" : money(expectedCashTotal)}</strong>
                <small>{matchModeLabel(match?.mode)}</small>
              </div>
              <div className="remittance-kpi">
                <span>Page cash</span>
                <strong>{money(collectedCash)}</strong>
                <small>Saved collected COD</small>
              </div>
              <div className={`remittance-kpi ${pageVsRemittance != null ? toneForAmount(-(pageVsRemittance)) : ""}`}>
                <span>Variance (page − remittance)</span>
                <strong>{money(pageVsRemittance ?? 0)}</strong>
                <small>Submit blocked if short exceeds ₹{SHORT_BLOCK_RUPEES}</small>
              </div>
            </div>

            <div className="remittance-meta-row">
              <div className="remittance-meta-item">
                <span>Match</span>
                <strong className={`remittance-status ${matchStatus === "MATCHED" ? "good" : matchStatus ? "warn" : ""}`}>
                  {matchStatusLabel(matchStatus)}
                </strong>
              </div>
              <div className="remittance-meta-item">
                <span>Same-day short</span>
                <strong className={sameDayShort != null ? toneForAmount(sameDayShort) : ""}>
                  {sameDayShort == null ? "—" : money(sameDayShort)}
                </strong>
              </div>
              <div className="remittance-meta-item">
                <span>Final pending</span>
                <strong>{match ? money(match.finalPendingTotal) : "—"}</strong>
              </div>
              <div className="remittance-meta-item">
                <span>Remittance codes</span>
                <strong>{remittance.remittanceCodes.length ? remittance.remittanceCodes.join(", ") : "—"}</strong>
              </div>
            </div>

            {isShortOverLimit ? (
              <div className="alert danger remittance-alert">
                <strong>Submission blocked — cash short exceeds ₹{SHORT_BLOCK_RUPEES}</strong>
                <span>
                  Collected cash is {money(Math.abs(pageVsRemittance ?? 0))} below remittance.
                  Resolve the short in SCC, then validate again.
                </span>
              </div>
            ) : null}

            {unresolvedPending ? (
              <div className="alert danger remittance-alert">
                <strong>Submission blocked — pending cash ledger</strong>
                <span>
                  Final pending of {money(match?.finalPendingTotal ?? 0)} is still open.
                  Open the ledger, clear forwarded or pending cash in SCC, then validate again.
                </span>
              </div>
            ) : null}

            {sameDayShortBlocked ? (
              <div className="alert danger remittance-alert">
                <strong>Submission blocked — same-day remittance short</strong>
                <span>
                  Same-day expected {money(match?.sameDayExpectedCashTotal ?? 0)} versus remittance {money(match?.sameDayRemittanceTotalCash ?? 0)}
                  {" "}(short {money(match?.sameDayShortAmount ?? 0)}). Clear this in SCC, then validate again.
                </span>
              </div>
            ) : null}

            {!isShortOverLimit && needsDifferenceRemarks ? (
              <div className="alert remittance-alert">
                <strong>Cash difference noted</strong>
                <span>
                  Variance of {money(pageVsRemittance ?? 0)} is beyond ₹{DIFFERENCE_REMARKS_RUPEES} and requires remarks when validating remittance.
                </span>
              </div>
            ) : null}

            {hasPendingCreated ? (
              <div className="alert remittance-alert">
                <strong>Pending remittance creation</strong>
                <span>
                  {remittance.createdCount} remittance{remittance.createdCount === 1 ? "" : "s"} totaling {money(remittance.createdTotal)} {remittance.createdCount === 1 ? "has" : "have"} been created but not yet submitted in SCC.
                </span>
              </div>
            ) : null}

            <div className="remittance-tables">
              <RemittanceRowsTable
                title="Pending remittances"
                meta="Awaiting submission in SCC"
                rows={remittance.created}
                emptyLabel="No pending remittances."
              />
              <RemittanceRowsTable
                title="Submitted remittances"
                meta={`Total ${money(remittance.submittedTotal)}`}
                rows={remittance.submitted}
                emptyLabel="No submitted remittances."
              />
            </div>
          </>
        ) : (
          <div className="remittance-empty-state">
            <strong>Remittance not loaded</strong>
            <p>Click Validate deposit to load SCC remittance, match summary, and the pending cash ledger.</p>
          </div>
        )}
      </section>

      <section className={`reconciliation-gate final remittance-final-panel ${!canSubmitFinal ? "locked" : ""}`}>
        <div className="reconciliation-gate-head">
          <div>
            <span>Final</span>
            <strong>Close station day</strong>
          </div>
          <span className={`remittance-status-pill ${isFinalSubmitted ? "good" : canSubmitFinal ? "good" : submitBlocked ? "danger" : ""}`}>
            {isFinalSubmitted ? "Submitted" : canSubmitFinal ? "Ready" : submitBlocked ? "Blocked" : "Pending"}
          </span>
        </div>
        <p className="subtle">Locks cash entries after remittance is validated and station liability is clear.</p>
        {submitBlocked ? (
          <div className="alert danger remittance-alert">
            <strong>Submission blocked</strong>
            <span>
              {isShortOverLimit ? `Collected cash is short by more than ₹${SHORT_BLOCK_RUPEES}. ` : ""}
              {unresolvedPending ? "Pending cash remains on the ledger. " : ""}
              {sameDayShortBlocked ? "Same-day remittance is still short. " : ""}
              Resolve the issue, then validate again.
            </span>
          </div>
        ) : null}
        <div className="form-actions">
          <button
            className="button"
            type="button"
            disabled={!canSubmitFinal || checkingLiability}
            onClick={() => void openLiabilityGate()}
          >
            {isFinalSubmitted
              ? "Final submission complete"
              : checkingLiability
                ? "Checking liability…"
                : submitting
                  ? "Submitting…"
                  : "Submit final COD closure"}
          </button>
        </div>
      </section>

      {showDifferenceModal && remittance && pageVsRemittance != null ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-panel wide cash-recon-modal" role="dialog" aria-modal="true" aria-labelledby="remittance-diff-title">
            <div className="panel-head">
              <div>
                <h2 id="remittance-diff-title">Cash variance versus remittance</h2>
                <p className="subtle">{stationCode} · {businessDate}</p>
              </div>
              <button className="modal-close" type="button" onClick={() => setShowDifferenceModal(false)} aria-label="Close">×</button>
            </div>
            <div className="panel-body">
              <div className="remittance-kpi-grid compact" style={{ marginBottom: 14 }}>
                <div className="remittance-kpi"><span>Page cash</span><strong>{money(collectedCash)}</strong></div>
                <div className="remittance-kpi"><span>Remittance</span><strong>{money(remittance.remittanceTotalCash)}</strong></div>
                <div className={`remittance-kpi ${toneForAmount(-(pageVsRemittance))}`}>
                  <span>Difference</span><strong>{money(pageVsRemittance)}</strong>
                </div>
              </div>
              <p className="subtle" style={{ marginTop: -6, marginBottom: 12 }}>
                {needsDifferenceRemarks && hasPendingCreated
                  ? `Variance is beyond ₹${DIFFERENCE_REMARKS_RUPEES}, and ${remittance.createdCount} remittance${remittance.createdCount === 1 ? "" : "s"} totaling ${money(remittance.createdTotal)} ${remittance.createdCount === 1 ? "is" : "are"} still pending creation in SCC.`
                  : needsDifferenceRemarks
                    ? `Variance is beyond the ₹${DIFFERENCE_REMARKS_RUPEES} auto-validate limit.`
                    : `The ₹${DIFFERENCE_REMARKS_RUPEES} cash variance itself is within tolerance — remarks are needed because ${remittance.createdCount} remittance${remittance.createdCount === 1 ? "" : "s"} totaling ${money(remittance.createdTotal)} ${remittance.createdCount === 1 ? "is" : "are"} still pending creation in SCC.`}
              </p>
              <label style={{ display: "grid", gap: 6 }}>
                Remarks
                <textarea
                  className="field"
                  rows={3}
                  value={validateRemarks}
                  onChange={(event) => setValidateRemarks(event.target.value)}
                  placeholder="Explain why deposit can be validated now"
                />
              </label>
              <div className="form-actions" style={{ marginTop: 14 }}>
                <button className="button secondary" type="button" onClick={() => setShowDifferenceModal(false)}>Cancel</button>
                <button
                  className="button"
                  type="button"
                  disabled={!validateRemarks.trim() || savingValidation}
                  onClick={() => void confirmDifferenceRemarks()}
                >
                  {savingValidation ? "Saving…" : "Save remarks and validate"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {showLiabilityModal ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-panel wide cash-recon-modal" role="dialog" aria-modal="true" aria-labelledby="liability-remind-title">
            <div className="panel-head">
              <div>
                <h2 id="liability-remind-title">Confirm liability before final submission</h2>
                <p className="subtle">{stationCode} · {businessDate}</p>
              </div>
              <button className="modal-close" type="button" disabled={submitting} onClick={() => setShowLiabilityModal(false)} aria-label="Close">×</button>
            </div>
            <div className="panel-body">
              <p className="subtle" style={{ marginBottom: 12 }}>
                Station cash liability in SCC must be clear before final COD submission.
              </p>
              {checkingLiability || !liability ? (
                <p className="subtle">Checking SCC liability…</p>
              ) : liability.isClear ? (
                <>
                  <div className="alert remittance-alert">
                    <strong>Liability is clear</strong>
                    <span>
                      Expected {money(liability.cashSummary.expectedAmount)} · Actual {money(liability.cashSummary.actualAmount)} ·
                      Short/excess {money(liability.cashSummary.shortExcessAmount)}.
                    </span>
                  </div>
                  <div className="form-actions">
                    <button className="button secondary" type="button" disabled={submitting} onClick={() => setShowLiabilityModal(false)}>Cancel</button>
                    <button className="button" type="button" disabled={submitting} onClick={() => void runFinalSubmit()}>
                      {submitting ? "Submitting…" : "Submit final COD closure"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="alert danger remittance-alert">
                    <strong>Liability is still open</strong>
                    <span>
                      Expected {money(liability.cashSummary.expectedAmount)} · Actual {money(liability.cashSummary.actualAmount)} ·
                      Short/excess {money(liability.cashSummary.shortExcessAmount)}. Complete clearance in SCC, then recheck.
                    </span>
                  </div>
                  <div className="form-actions">
                    <button className="button secondary" type="button" onClick={() => setShowLiabilityModal(false)}>Close</button>
                    <button className="button" type="button" disabled={checkingLiability} onClick={() => void openLiabilityGate()}>
                      {checkingLiability ? "Checking…" : "Recheck liability"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {showLedgerModal && remittance ? (
        <LedgerModal
          stationCode={stationCode}
          businessDate={businessDate}
          remittance={remittance}
          onClose={() => setShowLedgerModal(false)}
        />
      ) : null}
    </>
  );
}

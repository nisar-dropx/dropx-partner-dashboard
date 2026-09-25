"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { CashReconAssociate } from "@/lib/ops-pulse/cash-recon-types";
import { missingRequiredCashEntries, requiresManualDriverName } from "@/lib/ops-pulse/cash-recon-types";
import { raiseCodTechIssue, requestCashEntryException, resolveCodTechIssue } from "./cash-entry-actions";

type SavedCashEntry = {
  providerEmployeeId: string;
  name?: string | null;
};

function normalizeId(value: string) {
  return value.trim().toUpperCase();
}

type CashStepGateValue = {
  mode: "cash-recon" | "legacy";
  loaded: boolean;
  ready: boolean;
  zeroCashReady: boolean;
  required: CashReconAssociate[];
  /** Still missing a saved cash entry and blocking Step 1 -> Step 2. */
  missing: CashReconAssociate[];
  /** Still missing a saved cash entry, but excepted — does not block Step 1 -> Step 2. */
  exceptedPending: CashReconAssociate[];
  step2Href: string;
  savedCount: number;
  businessDate: string;
  locationId: string;
  stationCode: string;
  returnHref: string;
  /** Associates with an open tech issue for this station — carries forward regardless of business_date. */
  openTechIssueProviderIds: Set<string>;
  registerRequired: (required: CashReconAssociate[], loaded: boolean, zeroCashReady: boolean) => void;
  registerException: (providerEmployeeId: string) => void;
  registerTechIssueRaised: (providerEmployeeId: string) => void;
};

const CashStepGateContext = createContext<CashStepGateValue | null>(null);

function currency(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * "Will submit later" control for one row in the incomplete-drivers modal — a small
 * pill trigger that expands into a compact card in place, instead of a bare textarea
 * and two buttons stacked under the associate's name.
 */
function ExceptionRowForm({
  row,
  businessDate,
  locationId,
  stationCode,
  returnHref,
  isToday,
  onAdded
}: {
  row: CashReconAssociate;
  businessDate: string;
  locationId: string;
  stationCode: string;
  returnHref: string;
  isToday: boolean;
  onAdded: (providerEmployeeId: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isToday) return <span className="subtle">—</span>;

  if (!open) {
    return (
      <button className="exception-trigger" type="button" onClick={() => setOpen(true)}>
        Will submit later
      </button>
    );
  }

  return (
    <div className="exception-inline-form">
      <span className="exception-inline-form-label">Why is this associate&apos;s cash pending?</span>
      <textarea
        className="field"
        rows={2}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="e.g. Store will submit cash tomorrow"
        disabled={submitting}
        autoFocus
      />
      {error ? <p className="field-error">{error}</p> : null}
      <div className="form-actions">
        <button className="button ghost" type="button" disabled={submitting} onClick={() => setOpen(false)}>Cancel</button>
        <button
          className="button secondary"
          type="button"
          disabled={submitting || !reason.trim()}
          onClick={() => {
            setSubmitting(true);
            setError(null);
            const formData = new FormData();
            formData.set("response_mode", "client");
            formData.set("return_href", returnHref);
            formData.set("business_date", businessDate);
            formData.set("location_id", locationId);
            formData.set("station_code", stationCode);
            formData.set("provider_employee_id", row.providerEmployeeId);
            formData.set("associate_name", row.displayName || row.name);
            formData.set("expected_amount", String(row.expected ?? 0));
            formData.set("reason", reason.trim());
            void (async () => {
              try {
                const result = await requestCashEntryException(formData);
                if (result?.ok) {
                  // Stay on the cash sheet: the row drops out of the remaining list and the
                  // user carries on with the other drivers before continuing to Step 2.
                  onAdded(row.providerEmployeeId);
                  setOpen(false);
                  router.refresh();
                  return;
                }
                setError(result?.error ?? "Unable to add exception.");
              } catch (err) {
                setError(err instanceof Error ? err.message : "Unable to add exception.");
              } finally {
                setSubmitting(false);
              }
            })();
          }}
        >
          {submitting ? "Saving…" : "Confirm"}
        </button>
      </div>
    </div>
  );
}

/**
 * "Tech issue" control for one row — separate from "Will submit later"
 * (ExceptionRowForm): this is for when a device/app/network problem is
 * blocking the cash entry itself, not the associate simply being
 * unavailable. Unlike the inline exception card, this opens a small modal
 * since it needs a photo attachment, which doesn't fit well inline in a
 * table row.
 */
function TechIssueRowForm({
  row,
  businessDate,
  locationId,
  stationCode,
  returnHref,
  isToday,
  isOpenIssue,
  onRaised
}: {
  row: CashReconAssociate;
  businessDate: string;
  locationId: string;
  stationCode: string;
  returnHref: string;
  isToday: boolean;
  isOpenIssue: boolean;
  onRaised: (providerEmployeeId: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isOpenIssue) {
    return <span className="tech-issue-open-badge">Tech issue open</span>;
  }

  if (!isToday) return <span className="subtle">—</span>;

  return (
    <>
      <button className="tech-issue-trigger" type="button" onClick={() => setOpen(true)}>
        Tech issue
      </button>
      {open ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !submitting && setOpen(false)}>
          <section
            className="modal-panel tech-issue-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tech-issue-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="panel-head">
              <div>
                <h2 id="tech-issue-modal-title">Report a tech issue</h2>
                <p className="subtle">{row.displayName || row.name} · {row.providerEmployeeId}</p>
              </div>
              <button className="modal-close" type="button" onClick={() => setOpen(false)} disabled={submitting} aria-label="Close">×</button>
            </div>
            <div className="panel-body">
              <p className="subtle" style={{ marginBottom: 12 }}>
                This keeps the associate&apos;s cash entry on hold and carries forward every day until resolved — the
                station&apos;s reporting manager is notified when you submit this.
              </p>
              <label className="tech-issue-field-label">
                Remarks
                <textarea
                  className="field"
                  rows={3}
                  value={remarks}
                  onChange={(event) => setRemarks(event.target.value)}
                  placeholder="Describe the technical issue (e.g. app crashed, device not scanning, no network)"
                  disabled={submitting}
                  autoFocus
                />
              </label>
              <label className="tech-issue-field-label">
                Photo of the issue
                <input
                  className="field"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  disabled={submitting}
                  onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
                />
              </label>
              {error ? <p className="field-error">{error}</p> : null}
              <div className="form-actions" style={{ marginTop: 14 }}>
                <button className="button ghost" type="button" disabled={submitting} onClick={() => setOpen(false)}>Cancel</button>
                <button
                  className="button danger"
                  type="button"
                  disabled={submitting || !remarks.trim()}
                  onClick={() => {
                    setSubmitting(true);
                    setError(null);
                    const formData = new FormData();
                    formData.set("response_mode", "client");
                    formData.set("return_href", returnHref);
                    formData.set("business_date", businessDate);
                    formData.set("location_id", locationId);
                    formData.set("station_code", stationCode);
                    formData.set("provider_employee_id", row.providerEmployeeId);
                    formData.set("associate_name", row.displayName || row.name);
                    formData.set("remarks", remarks.trim());
                    if (photo) formData.set("photo", photo);
                    void (async () => {
                      try {
                        const result = await raiseCodTechIssue(formData);
                        if (result?.ok) {
                          // Same as "will submit later": stay on the cash sheet.
                          onRaised(row.providerEmployeeId);
                          setOpen(false);
                          router.refresh();
                          return;
                        }
                        setError(result?.error ?? "Unable to record the tech issue.");
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Unable to record the tech issue.");
                      } finally {
                        setSubmitting(false);
                      }
                    })();
                  }}
                >
                  {submitting ? "Submitting…" : "Report"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function IncompleteDriversModal({
  missing,
  requiredCount,
  loaded,
  businessDate,
  locationId,
  stationCode,
  returnHref,
  isToday,
  openTechIssueProviderIds,
  onException,
  onTechIssueRaised,
  onClose
}: {
  missing: CashReconAssociate[];
  requiredCount: number;
  loaded: boolean;
  businessDate: string;
  locationId: string;
  stationCode: string;
  returnHref: string;
  isToday: boolean;
  openTechIssueProviderIds: Set<string>;
  onException: (providerEmployeeId: string) => void;
  onTechIssueRaised: (providerEmployeeId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-panel wide cash-recon-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="incomplete-drivers-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="panel-head">
          <div>
            <h2 id="incomplete-drivers-title">Complete driver denominations</h2>
            <p className="subtle">
              Enter and save cash for every associate with expected &gt; 0 before continuing
              ({missing.length} of {Math.max(requiredCount, missing.length)} remaining).
            </p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="panel-body">
          <p className="subtle" style={{ marginBottom: 12 }}>
            Select each driver in <strong>Collect cash</strong> or <strong>Add associate missing from DER</strong>,
            count denominations, and save. Drivers without a resolved name still show a Driver ID — type the employee name when entering cash.
            {isToday ? " Continue unlocks once every row is entered or marked “will submit later.”" : " Continue unlocks only when all are entered."}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Associate</th>
                  <th>Driver / Employee ID</th>
                  <th>Expected</th>
                  <th>{isToday ? "Not ready today?" : ""}</th>
                  <th>{isToday ? "Tech issue?" : ""}</th>
                </tr>
              </thead>
              <tbody>
                {missing.length ? missing.map((row) => {
                  const label = row.displayName || row.name;
                  const needsTypedName = requiresManualDriverName({
                    name: String(label),
                    shipmentType: String(row.shipmentType ?? ""),
                    employeeId: String(row.employeeId ?? row.providerEmployeeId ?? ""),
                    mappedFromWorkforce: row.mappedFromWorkforce
                  });
                  return (
                    <tr key={row.providerEmployeeId}>
                      <td>
                        <strong>{label}</strong>
                        {needsTypedName ? (
                          <div className="subtle" style={{ marginTop: 4 }}>
                            Type employee name when entering cash (Missing DER).
                          </div>
                        ) : null}
                      </td>
                      <td>{row.providerEmployeeId}</td>
                      <td>₹{currency(row.expected)}</td>
                      <td>
                        <ExceptionRowForm
                          row={row}
                          businessDate={businessDate}
                          locationId={locationId}
                          stationCode={stationCode}
                          returnHref={returnHref}
                          isToday={isToday}
                          onAdded={onException}
                        />
                      </td>
                      <td>
                        <TechIssueRowForm
                          row={row}
                          businessDate={businessDate}
                          locationId={locationId}
                          stationCode={stationCode}
                          returnHref={returnHref}
                          isToday={isToday}
                          isOpenIssue={openTechIssueProviderIds.has(normalizeId(row.providerEmployeeId))}
                          onRaised={onTechIssueRaised}
                        />
                      </td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td className="empty-cell" colSpan={5}>
                      {!loaded
                        ? "Cash-recon drivers are still loading. Wait for the driver list, then enter denominations."
                        : requiredCount === 0
                          ? "No associates with expected > 0 were found in the cash-recon response for this station/date. Click Refresh drivers and try again."
                          : "All required associates have saved cash entries."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="form-actions" style={{ marginTop: 16 }}>
            <button className="button" type="button" onClick={onClose}>Back to cash sheet</button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function CashStepGateProvider({
  children,
  initialRequired = [],
  initialExceptedProviderIds = [],
  initialOpenTechIssueProviderIds = [],
  mode,
  savedCount,
  savedEntries,
  step2Href,
  businessDate,
  locationId,
  stationCode,
  returnHref
}: {
  children: ReactNode;
  initialRequired?: CashReconAssociate[];
  /** Associates with an open "will submit later" exception for this station-day. */
  initialExceptedProviderIds?: string[];
  /** Associates with an open tech issue for this station — not scoped to today, carries forward. */
  initialOpenTechIssueProviderIds?: string[];
  mode: "cash-recon" | "legacy";
  savedCount: number;
  savedEntries: SavedCashEntry[];
  step2Href: string;
  businessDate: string;
  locationId: string;
  stationCode: string;
  returnHref: string;
}) {
  const [loaded, setLoaded] = useState(mode !== "cash-recon" || initialRequired.length > 0);
  const [required, setRequired] = useState<CashReconAssociate[]>(initialRequired);
  const [zeroCashReady, setZeroCashReady] = useState(false);
  const [clientSavedEntries, setClientSavedEntries] = useState<SavedCashEntry[]>(savedEntries);
  const [exceptedIds, setExceptedIds] = useState<Set<string>>(
    () => new Set(initialExceptedProviderIds.map(normalizeId))
  );
  const [openTechIssueProviderIds, setOpenTechIssueProviderIds] = useState<Set<string>>(
    () => new Set(initialOpenTechIssueProviderIds.map(normalizeId))
  );

  const registerRequired = useCallback((nextRequired: CashReconAssociate[], isLoaded: boolean, isZeroCashReady: boolean) => {
    setRequired(nextRequired);
    setLoaded(isLoaded);
    setZeroCashReady(isZeroCashReady);
  }, []);

  const registerException = useCallback((providerEmployeeId: string) => {
    setExceptedIds((current) => new Set(current).add(normalizeId(providerEmployeeId)));
  }, []);

  const registerTechIssueRaised = useCallback((providerEmployeeId: string) => {
    setOpenTechIssueProviderIds((current) => new Set(current).add(normalizeId(providerEmployeeId)));
  }, []);

  useEffect(() => {
    setClientSavedEntries(savedEntries);
  }, [savedEntries]);

  useEffect(() => {
    setExceptedIds(new Set(initialExceptedProviderIds.map(normalizeId)));
  }, [initialExceptedProviderIds]);

  useEffect(() => {
    setOpenTechIssueProviderIds(new Set(initialOpenTechIssueProviderIds.map(normalizeId)));
  }, [initialOpenTechIssueProviderIds]);

  useEffect(() => {
    function handleSaved(event: Event) {
      const detail = (event as CustomEvent<{ provider_employee_id?: string | null; source_associate_name?: string | null; manual_associate_name?: string | null }>).detail;
      const providerEmployeeId = String(detail?.provider_employee_id ?? "").trim();
      if (!providerEmployeeId) return;
      const name = String(detail?.source_associate_name ?? detail?.manual_associate_name ?? "").trim() || null;
      setClientSavedEntries((current) => {
        const next = current.filter((row) => row.providerEmployeeId.trim().toUpperCase() !== providerEmployeeId.toUpperCase());
        next.push({ providerEmployeeId, name });
        return next;
      });
      // Saving cash for this associate resolves any exception raised against them.
      setExceptedIds((current) => {
        const key = normalizeId(providerEmployeeId);
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }

    function handleDeleted(event: Event) {
      const detail = (event as CustomEvent<{ provider_employee_id?: string | null }>).detail;
      const providerEmployeeId = String(detail?.provider_employee_id ?? "").trim();
      if (!providerEmployeeId) return;
      setClientSavedEntries((current) => current.filter((row) => row.providerEmployeeId.trim().toUpperCase() !== providerEmployeeId.toUpperCase()));
    }

    window.addEventListener("executive-reconciliation:saved", handleSaved as EventListener);
    window.addEventListener("executive-reconciliation:deleted", handleDeleted as EventListener);
    return () => {
      window.removeEventListener("executive-reconciliation:saved", handleSaved as EventListener);
      window.removeEventListener("executive-reconciliation:deleted", handleDeleted as EventListener);
    };
  }, []);

  const notSaved = useMemo(
    () => missingRequiredCashEntries(required, clientSavedEntries),
    [required, clientSavedEntries]
  );
  const missing = useMemo(
    () => notSaved.filter((row) => !exceptedIds.has(normalizeId(row.providerEmployeeId)) && !openTechIssueProviderIds.has(normalizeId(row.providerEmployeeId))),
    [notSaved, exceptedIds, openTechIssueProviderIds]
  );
  const exceptedPending = useMemo(
    () => notSaved.filter((row) => exceptedIds.has(normalizeId(row.providerEmployeeId)) || openTechIssueProviderIds.has(normalizeId(row.providerEmployeeId))),
    [notSaved, exceptedIds, openTechIssueProviderIds]
  );

  const currentSavedCount = clientSavedEntries.length;

  const ready = mode === "legacy"
    ? currentSavedCount > 0
    : Boolean(loaded && ((required.length > 0 && missing.length === 0) || zeroCashReady));

  const value = useMemo(
    () => ({
      mode,
      loaded,
      ready,
      zeroCashReady,
      required,
      missing,
      exceptedPending,
      step2Href,
      savedCount: currentSavedCount,
      businessDate,
      locationId,
      stationCode,
      returnHref,
      openTechIssueProviderIds,
      registerRequired,
      registerException,
      registerTechIssueRaised
    }),
    [mode, loaded, ready, zeroCashReady, required, missing, exceptedPending, step2Href, currentSavedCount, businessDate, locationId, stationCode, returnHref, openTechIssueProviderIds, registerRequired, registerException, registerTechIssueRaised]
  );

  return <CashStepGateContext.Provider value={value}>{children}</CashStepGateContext.Provider>;
}

export function useRegisterCashStepRequired(required: CashReconAssociate[], loaded: boolean, zeroCashReady = false) {
  const ctx = useContext(CashStepGateContext);
  const registerRequired = ctx?.registerRequired;
  const requiredKey = required
    .map((row) => `${row.providerEmployeeId}:${row.expected}`)
    .sort()
    .join("|");

  useEffect(() => {
    // Do not wipe server-seeded required list while the client fetch is still in flight.
    if (!loaded) return;
    registerRequired?.(required, true, zeroCashReady);
  }, [requiredKey, loaded, registerRequired, required, zeroCashReady]);
}

export function ContinueToDriverValidation() {
  const ctx = useContext(CashStepGateContext);
  const [showModal, setShowModal] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const router = useRouter();
  if (!ctx) return null;

  const {
    mode, loaded, ready, zeroCashReady, required, missing, exceptedPending, step2Href, savedCount,
    businessDate, locationId, stationCode, returnHref, openTechIssueProviderIds, registerException, registerTechIssueRaised
  } = ctx;
  const blocked = mode === "legacy" ? savedCount === 0 : !ready;
  const isToday = businessDate === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

  if (mode === "legacy" && !savedCount) return null;

  const statusText = mode === "legacy"
    ? "Review differences before submitting COD."
    : !loaded
      ? "Waiting for cash-recon drivers… then enter cash for every associate with expected > 0."
      : zeroCashReady
        ? "No pending recon and no cash expected for this station/date. You can continue to driver validation."
      : required.length === 0
        ? "No associates with expected > 0 found yet. Refresh drivers, then enter denominations."
        : blocked
          ? `Enter cash for all ${required.length} associate${required.length === 1 ? "" : "s"} with expected > 0 · ${missing.length} remaining.`
          : exceptedPending.length
            ? `All entries done or excepted. ${exceptedPending.length} still pending (excepted) — final close stays locked until entered.`
            : `All ${required.length} associate${required.length === 1 ? "" : "s"} with expected > 0 entered. Review differences before submitting COD.`;

  return (
    <>
      <div className="reconciliation-stage-footer">
        <span>{statusText}</span>
        {blocked ? (
          <button
            className="button"
            type="button"
            aria-disabled="true"
            style={{ opacity: 0.62, cursor: "not-allowed" }}
            onClick={() => setShowModal(true)}
          >
            Continue to driver validation →
          </button>
        ) : (
          <button
            className="button"
            type="button"
            disabled={navigating}
            onClick={() => {
              setNavigating(true);
              router.push(step2Href);
            }}
          >
            {navigating ? "Opening driver validation…" : "Continue to driver validation →"}
          </button>
        )}
      </div>
      {showModal ? (
        <IncompleteDriversModal
          missing={mode === "legacy" ? [] : missing}
          requiredCount={mode === "legacy" ? 0 : required.length}
          loaded={mode === "legacy" ? true : loaded}
          businessDate={businessDate}
          locationId={locationId}
          stationCode={stationCode}
          returnHref={returnHref}
          isToday={isToday}
          openTechIssueProviderIds={openTechIssueProviderIds}
          onException={registerException}
          onTechIssueRaised={registerTechIssueRaised}
          onClose={() => setShowModal(false)}
        />
      ) : null}
    </>
  );
}

export function DriverValidationNavLink({
  className,
  href,
  lockedHref,
  children
}: {
  className: string;
  href: string;
  lockedHref: string;
  children: ReactNode;
}) {
  const ctx = useContext(CashStepGateContext);
  const [showModal, setShowModal] = useState(false);
  const router = useRouter();
  const ready = ctx?.ready ?? false;
  const missing = ctx?.missing ?? [];
  const required = ctx?.required ?? [];
  const loaded = ctx?.loaded ?? false;
  const mode = ctx?.mode ?? "legacy";
  const businessDate = ctx?.businessDate ?? "";
  const locationId = ctx?.locationId ?? "";
  const stationCode = ctx?.stationCode ?? "";
  const returnHref = ctx?.returnHref ?? "";
  const openTechIssueProviderIds = ctx?.openTechIssueProviderIds ?? new Set<string>();
  const registerException = ctx?.registerException ?? (() => undefined);
  const registerTechIssueRaised = ctx?.registerTechIssueRaised ?? (() => undefined);
  const isToday = businessDate === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

  return (
    <>
      <a
        className={`${className}${ready ? "" : " locked"}`}
        href={ready ? href : lockedHref}
        aria-disabled={!ready}
        onClick={(event) => {
          if (ready) {
            event.preventDefault();
            router.push(href);
            return;
          }
          event.preventDefault();
          if (mode === "cash-recon") setShowModal(true);
        }}
      >
        {children}
      </a>
      {showModal ? (
        <IncompleteDriversModal
          missing={missing}
          requiredCount={required.length}
          loaded={loaded}
          businessDate={businessDate}
          locationId={locationId}
          stationCode={stationCode}
          returnHref={returnHref}
          isToday={isToday}
          openTechIssueProviderIds={openTechIssueProviderIds}
          onException={registerException}
          onTechIssueRaised={registerTechIssueRaised}
          onClose={() => setShowModal(false)}
        />
      ) : null}
    </>
  );
}

/** "Resolve" action for one open tech issue row — deletes the attached photo server-side (see resolveTechIssue). */
export function ResolveTechIssueButton({
  techIssueId,
  locationId,
  returnHref
}: {
  techIssueId: string;
  locationId: string;
  returnHref: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="tech-issue-resolve-cell">
      <button
        className="button secondary small"
        type="button"
        disabled={submitting}
        onClick={() => {
          if (!window.confirm("Mark this tech issue resolved? The attached photo will be deleted.")) return;
          setSubmitting(true);
          setError(null);
          const formData = new FormData();
          formData.set("response_mode", "client");
          formData.set("return_href", returnHref);
          formData.set("tech_issue_id", techIssueId);
          formData.set("location_id", locationId);
          void (async () => {
            try {
              const result = await resolveCodTechIssue(formData);
              if (result?.ok) {
                router.refresh();
                return;
              }
              setError(result?.error ?? "Unable to resolve the tech issue.");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Unable to resolve the tech issue.");
            } finally {
              setSubmitting(false);
            }
          })();
        }}
      >
        {submitting ? "Resolving…" : "Resolve"}
      </button>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

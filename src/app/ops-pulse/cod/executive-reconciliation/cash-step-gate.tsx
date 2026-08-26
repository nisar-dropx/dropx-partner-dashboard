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
import { requestCashEntryException } from "./cash-entry-actions";

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
  registerRequired: (required: CashReconAssociate[], loaded: boolean, zeroCashReady: boolean) => void;
  registerException: (providerEmployeeId: string) => void;
};

const CashStepGateContext = createContext<CashStepGateValue | null>(null);

function currency(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Inline "will submit later" form for one row in the incomplete-drivers modal. */
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

  if (!isToday) return null;

  if (!open) {
    return (
      <button className="button ghost" type="button" onClick={() => setOpen(true)} style={{ marginTop: 6 }}>
        Add exception — will submit later
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <textarea
        className="field"
        rows={2}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="e.g. Store will submit cash tomorrow"
        disabled={submitting}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="button"
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
                  onAdded(row.providerEmployeeId);
                  router.push(result.nextHref || returnHref);
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
          {submitting ? "Saving…" : "Save exception & continue"}
        </button>
        <button className="button ghost" type="button" disabled={submitting} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
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
  onException,
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
  onException: (providerEmployeeId: string) => void;
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
            Continue unlocks only when all are entered{isToday ? ", or excepted below for a store/associate that will submit cash later" : ""}.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Associate</th>
                  <th>Driver / Employee ID</th>
                  <th>Expected</th>
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
                      <td>{row.providerEmployeeId}</td>
                      <td>₹{currency(row.expected)}</td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td className="empty-cell" colSpan={3}>
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

  const registerRequired = useCallback((nextRequired: CashReconAssociate[], isLoaded: boolean, isZeroCashReady: boolean) => {
    setRequired(nextRequired);
    setLoaded(isLoaded);
    setZeroCashReady(isZeroCashReady);
  }, []);

  const registerException = useCallback((providerEmployeeId: string) => {
    setExceptedIds((current) => new Set(current).add(normalizeId(providerEmployeeId)));
  }, []);

  useEffect(() => {
    setClientSavedEntries(savedEntries);
  }, [savedEntries]);

  useEffect(() => {
    setExceptedIds(new Set(initialExceptedProviderIds.map(normalizeId)));
  }, [initialExceptedProviderIds]);

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
    () => notSaved.filter((row) => !exceptedIds.has(normalizeId(row.providerEmployeeId))),
    [notSaved, exceptedIds]
  );
  const exceptedPending = useMemo(
    () => notSaved.filter((row) => exceptedIds.has(normalizeId(row.providerEmployeeId))),
    [notSaved, exceptedIds]
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
      registerRequired,
      registerException
    }),
    [mode, loaded, ready, zeroCashReady, required, missing, exceptedPending, step2Href, currentSavedCount, businessDate, locationId, stationCode, returnHref, registerRequired, registerException]
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
    businessDate, locationId, stationCode, returnHref, registerException
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
          onException={registerException}
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
  const registerException = ctx?.registerException ?? (() => undefined);
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
          onException={registerException}
          onClose={() => setShowModal(false)}
        />
      ) : null}
    </>
  );
}

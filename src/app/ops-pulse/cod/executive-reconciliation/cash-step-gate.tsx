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

type SavedCashEntry = {
  providerEmployeeId: string;
  name?: string | null;
};

type CashStepGateValue = {
  mode: "cash-recon" | "legacy";
  loaded: boolean;
  ready: boolean;
  zeroCashReady: boolean;
  required: CashReconAssociate[];
  missing: CashReconAssociate[];
  step2Href: string;
  savedCount: number;
  registerRequired: (required: CashReconAssociate[], loaded: boolean, zeroCashReady: boolean) => void;
};

const CashStepGateContext = createContext<CashStepGateValue | null>(null);

function currency(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function IncompleteDriversModal({
  missing,
  requiredCount,
  loaded,
  onClose
}: {
  missing: CashReconAssociate[];
  requiredCount: number;
  loaded: boolean;
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
            Continue unlocks only when all are entered.
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
  mode,
  savedCount,
  savedEntries,
  step2Href
}: {
  children: ReactNode;
  initialRequired?: CashReconAssociate[];
  mode: "cash-recon" | "legacy";
  savedCount: number;
  savedEntries: SavedCashEntry[];
  step2Href: string;
}) {
  const [loaded, setLoaded] = useState(mode !== "cash-recon" || initialRequired.length > 0);
  const [required, setRequired] = useState<CashReconAssociate[]>(initialRequired);
  const [zeroCashReady, setZeroCashReady] = useState(false);
  const [clientSavedEntries, setClientSavedEntries] = useState<SavedCashEntry[]>(savedEntries);

  const registerRequired = useCallback((nextRequired: CashReconAssociate[], isLoaded: boolean, isZeroCashReady: boolean) => {
    setRequired(nextRequired);
    setLoaded(isLoaded);
    setZeroCashReady(isZeroCashReady);
  }, []);

  useEffect(() => {
    setClientSavedEntries(savedEntries);
  }, [savedEntries]);

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

  const missing = useMemo(
    () => missingRequiredCashEntries(required, clientSavedEntries),
    [required, clientSavedEntries]
  );

  const currentSavedCount = clientSavedEntries.length;

  const ready = mode === "legacy"
    ? currentSavedCount > 0
    : Boolean(loaded && ((required.length > 0 && missing.length === 0) || zeroCashReady));

  const value = useMemo(
    () => ({ mode, loaded, ready, zeroCashReady, required, missing, step2Href, savedCount: currentSavedCount, registerRequired }),
    [mode, loaded, ready, zeroCashReady, required, missing, step2Href, currentSavedCount, registerRequired]
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

  const { mode, loaded, ready, zeroCashReady, required, missing, step2Href, savedCount } = ctx;
  const blocked = mode === "legacy" ? savedCount === 0 : !ready;

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
          onClose={() => setShowModal(false)}
        />
      ) : null}
    </>
  );
}

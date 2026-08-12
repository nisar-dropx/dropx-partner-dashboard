"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
  CashReconAssociate,
  CashReconDriver,
  CashReconPendingBreakdown,
  CashReconRow,
  ExpectedCashSummary
} from "@/lib/ops-pulse/cash-recon-types";
import {
  associateNamesMatch,
  indexExpectedCashByDriver,
  moneyValue,
  requiresManualDriverName,
  resolveCashExpected
} from "@/lib/ops-pulse/cash-recon-types";
import {
  driverReconCacheKey,
  readDriverReconCache,
  writeDriverReconCache,
  type DriverReconClientPayload
} from "@/lib/ops-pulse/driver-recon-client-cache";
import { AssociateEntryBuilder, type AssociateOption } from "./associate-entry-builder";
import { useRegisterCashStepRequired } from "./cash-step-gate";
import { MissingDerPanel } from "./missing-der-panel";

function mapBreakdown(payment: CashReconRow["paymentInfo"] | CashReconPendingBreakdown[] | undefined): CashReconPendingBreakdown[] {
  if (Array.isArray(payment)) return payment;
  const rows = Array.isArray(payment?.overallPendingReconBreakdownList)
    ? payment.overallPendingReconBreakdownList
    : [];
  return rows.map((row) => ({
    trackingId: String(row?.trackingId ?? "").trim() || "-",
    paymentMethod: String(row?.paymentMethod ?? "").trim() || "-",
    moneyCollectionTime: typeof (row as { moneyCollectionTime?: number; transactionTime?: number })?.moneyCollectionTime === "number"
      ? (row as { moneyCollectionTime: number }).moneyCollectionTime
      : typeof (row as { transactionTime?: number })?.transactionTime === "number"
        ? (row as { transactionTime: number }).transactionTime
        : null,
    amount: moneyValue(row?.amount),
    stationTimeZone: String(row?.stationTimeZone ?? "").trim() || "IST"
  }));
}

function findApiAssociate(
  associate: AssociateOption,
  apiAssociates: CashReconAssociate[],
  drivers: CashReconDriver[]
) {
  const id = String(associate.providerEmployeeId ?? "").trim().toUpperCase();
  const shortName = String(associate.name ?? "").split("/")[0]?.trim() || String(associate.name ?? "").trim();

  const byId = apiAssociates.find((row) => {
    const providerId = String(row.providerEmployeeId ?? "").trim().toUpperCase();
    const employeeId = String(row.employeeId ?? "").trim().toUpperCase();
    return id && (providerId === id || employeeId === id);
  });
  if (byId) return byId;

  const driver = drivers.find((row) => {
    const employeeId = String(row.employeeId ?? "").trim().toUpperCase();
    const tasId = String(row.tasId ?? "").trim().toUpperCase();
    return id && (employeeId === id || tasId === id);
  });
  if (driver) {
    const tasId = String(driver.tasId ?? "").trim().toUpperCase();
    const employeeId = String(driver.employeeId ?? "").trim().toUpperCase();
    const byDriver = apiAssociates.find((row) => {
      const providerId = String(row.providerEmployeeId ?? "").trim().toUpperCase();
      const rowEmployeeId = String(row.employeeId ?? "").trim().toUpperCase();
      return (tasId && providerId === tasId)
        || (employeeId && (providerId === employeeId || rowEmployeeId === employeeId));
    });
    if (byDriver) return byDriver;
  }

  return apiAssociates.find((row) =>
    associateNamesMatch(shortName, String(row.displayName || row.name || ""))
  ) ?? null;
}

/** Collect cash = DB associates only; amounts/names enriched from API associates + drivers. */
function enrichCollectCash(
  dbAssociates: AssociateOption[],
  apiAssociates: CashReconAssociate[],
  drivers: CashReconDriver[],
  reconciliation: CashReconRow[],
  expectedCash: ExpectedCashSummary | null
) {
  const expectedCashIndex = indexExpectedCashByDriver(expectedCash);
  const hasExpectedCashPayload = Array.isArray(expectedCash?.byDriver);

  return dbAssociates.map((associate) => {
    const api = findApiAssociate(associate, apiAssociates, drivers);
    const id = String(associate.providerEmployeeId ?? "").trim().toUpperCase();
    const driver = drivers.find((row) => {
      const employeeId = String(row.employeeId ?? "").trim().toUpperCase();
      const tasId = String(row.tasId ?? "").trim().toUpperCase();
      return employeeId === id || tasId === id
        || String(row.driverName ?? "").trim() === String(associate.name ?? "").trim();
    });
    const recon = api
      ? null
      : reconciliation.find((row) => {
        const reconId = String(row.driverInfo?.id ?? "").trim().toUpperCase();
        const shortName = String(associate.name ?? "").split("/")[0]?.trim() || "";
        return (driver?.tasId && reconId === String(driver.tasId).trim().toUpperCase())
          || reconId === id
          || associateNamesMatch(shortName, String(row.driverInfo?.name ?? ""));
      });

    const expected = api
      ? Number(api.expected) || 0
      : resolveCashExpected({
          employeeId: driver?.employeeId ?? associate.providerEmployeeId,
          tasId: driver?.tasId ?? recon?.driverInfo?.id,
          expectedCashIndex,
          hasExpectedCashPayload,
          reconExpected: recon?.paymentInfo?.expected
        });
    const pendingRecon = api
      ? Number(api.pendingRecon) || 0
      : moneyValue(recon?.paymentInfo?.overallPendingRecon);
    const fullName = String(driver?.driverName ?? "").trim()
      || String(api?.displayName || api?.name || "").trim()
      || associate.name;

    return {
      ...associate,
      name: fullName,
      shipmentType: "Shipment data",
      pendingAmount: expected,
      expectedAmount: expected,
      pendingRecon,
      breakdown: api?.breakdown?.length
        ? api.breakdown
        : mapBreakdown(recon?.paymentInfo)
    } satisfies AssociateOption;
  });
}

function mapMissingFromDer(apiMissing: CashReconAssociate[]): AssociateOption[] {
  const rows: AssociateOption[] = apiMissing
    .filter((row) => String(row.providerEmployeeId ?? "").trim().toLowerCase() !== "__other__")
    .map((row) => {
      const employeeId = String(row.employeeId ?? "").trim();
      const fallbackId = String(row.providerEmployeeId ?? "").trim();
      const providerEmployeeId = employeeId && employeeId !== "0" ? employeeId : fallbackId;
      const rawName = String(row.displayName || row.name || "").trim();
      const shipmentType = row.shipmentType || "Cash recon worker";
      const mappedFromWorkforce = row.mappedFromWorkforce === true
        || shipmentType.toLowerCase().includes("workforce");
      const requiresManualName = requiresManualDriverName({
        name: rawName,
        shipmentType,
        employeeId,
        mappedFromWorkforce
      });
      const name = requiresManualName && providerEmployeeId && /^Unmapped driver/i.test(rawName)
        ? `Unmapped · ${providerEmployeeId}`
        : rawName;
      return {
        name,
        providerEmployeeId,
        shipmentType,
        pendingAmount: Number(row.expected) || 0,
        expectedAmount: Number(row.expected) || 0,
        pendingRecon: Number(row.pendingRecon) || 0,
        breakdown: Array.isArray(row.breakdown) ? row.breakdown : [],
        requiresManualName,
        mappedFromWorkforce
      } satisfies AssociateOption;
    })
    .filter((row) => row.providerEmployeeId && row.name);

  rows.push({
    name: "Other",
    providerEmployeeId: "__other__",
    shipmentType: "Manual entry",
    pendingAmount: 0,
    expectedAmount: 0,
    pendingRecon: 0,
    breakdown: [],
    requiresManualName: true
  });

  return rows;
}

function toCashReconAssociate(row: AssociateOption, source: CashReconAssociate["source"]): CashReconAssociate {
  return {
    providerEmployeeId: row.providerEmployeeId,
    name: row.name,
    displayName: row.name,
    employeeId: null,
    expected: Number(row.expectedAmount) || 0,
    pendingRecon: Number(row.pendingRecon) || 0,
    breakdown: row.breakdown ?? [],
    source,
    shipmentType: row.shipmentType,
    mappedFromWorkforce: row.mappedFromWorkforce
  };
}

function applyPayload(
  payload: DriverReconClientPayload,
  setters: {
    setDrivers: (v: CashReconDriver[]) => void;
    setReconciliation: (v: CashReconRow[]) => void;
    setApiAssociates: (v: CashReconAssociate[]) => void;
    setApiMissingFromDer: (v: CashReconAssociate[]) => void;
    setApiRequired: (v: CashReconAssociate[]) => void;
    setExpectedCash: (v: ExpectedCashSummary | null) => void;
    setSessionSource: (v: string | null) => void;
  }
) {
  setters.setDrivers(payload.drivers);
  setters.setReconciliation(payload.reconciliation);
  setters.setApiAssociates(payload.associates);
  setters.setApiMissingFromDer(payload.missingFromDer);
  setters.setApiRequired(payload.requiredForCashEntry);
  setters.setExpectedCash(payload.expectedCash);
  setters.setSessionSource(payload.sessionSource);
}

export function CashCollectionWorkspace({
  dbAssociates,
  businessDate,
  canAdd,
  canEdit,
  locationId,
  returnHref,
  savedProviderEmployeeIds,
  savedCount,
  stationCode,
  stationLabel,
  workerConfigured
}: {
  dbAssociates: AssociateOption[];
  businessDate: string;
  canAdd: boolean;
  canEdit: boolean;
  locationId: string;
  returnHref: string;
  savedProviderEmployeeIds: string[];
  savedCount: number;
  stationCode: string;
  stationLabel: string;
  workerConfigured: boolean;
}) {
  const baselineKey = useMemo(
    () => JSON.stringify(
      dbAssociates.map((row) => row.providerEmployeeId).sort()
    ),
    [dbAssociates]
  );

  const cacheKey = useMemo(
    () => driverReconCacheKey({ stationCode, businessDate, locationId, baselineKey }),
    [baselineKey, businessDate, locationId, stationCode]
  );

  // Sync hydrate from module cache so save/delete remounts never blank the sheet.
  const initialCache = workerConfigured ? readDriverReconCache(cacheKey) : null;

  const [drivers, setDrivers] = useState<CashReconDriver[]>(() => initialCache?.drivers ?? []);
  const [reconciliation, setReconciliation] = useState<CashReconRow[]>(() => initialCache?.reconciliation ?? []);
  const [apiAssociates, setApiAssociates] = useState<CashReconAssociate[]>(() => initialCache?.associates ?? []);
  const [apiMissingFromDer, setApiMissingFromDer] = useState<CashReconAssociate[]>(() => initialCache?.missingFromDer ?? []);
  const [apiRequired, setApiRequired] = useState<CashReconAssociate[]>(() => initialCache?.requiredForCashEntry ?? []);
  const [expectedCash, setExpectedCash] = useState<ExpectedCashSummary | null>(() => initialCache?.expectedCash ?? null);
  const [sessionSource, setSessionSource] = useState<string | null>(() => initialCache?.sessionSource ?? null);
  const [error, setError] = useState<string | null>(null);
  /** True only for the first network fetch when there is no cache. */
  const [loading, setLoading] = useState(false);
  /** Soft background refresh — keeps sheet visible. */
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(() => Boolean(initialCache) || !workerConfigured);
  const [pending, startTransition] = useTransition();
  const requestIdRef = useRef(0);
  const hydratedKeyRef = useRef<string | null>(initialCache ? cacheKey : null);
  const baselineRef = useRef<{ providerEmployeeId: string; name: string }[]>([]);
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;

  const baselineAssociates = useMemo(
    () => dbAssociates.map((row) => ({
      providerEmployeeId: row.providerEmployeeId,
      name: row.name
    })),
    [dbAssociates]
  );
  baselineRef.current = baselineAssociates;

  const setters = useMemo(() => ({
    setDrivers,
    setReconciliation,
    setApiAssociates,
    setApiMissingFromDer,
    setApiRequired,
    setExpectedCash,
    setSessionSource
  }), []);

  const fetchDriverRecon = useCallback(async (options?: { force?: boolean; soft?: boolean }) => {
    if (!workerConfigured || !stationCode || !businessDate || !locationId) return;
    const key = cacheKeyRef.current;
    const force = Boolean(options?.force);
    const soft = Boolean(options?.soft);

    if (!force) {
      const cached = readDriverReconCache(key);
      if (cached) {
        applyPayload(cached, setters);
        setLoaded(true);
        setError(null);
        hydratedKeyRef.current = key;
        return;
      }
    }

    const requestId = ++requestIdRef.current;
    if (soft) setRefreshing(true);
    else {
      setLoading(true);
      if (hydratedKeyRef.current !== key) setLoaded(false);
    }
    setError(null);

    try {
      const response = await fetch("/api/ops-pulse/cod/cash-recon/driver-reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stationCode,
          date: businessDate,
          locationId,
          baselineAssociates: baselineRef.current
        })
      });
      const body = await response.json().catch(() => ({}));
      if (requestId !== requestIdRef.current) return;
      if (!response.ok) {
        throw new Error(body?.error || `Unable to load drivers (${response.status})`);
      }

      const payload: DriverReconClientPayload = {
        drivers: Array.isArray(body.drivers) ? body.drivers : [],
        reconciliation: Array.isArray(body.reconciliation) ? body.reconciliation : [],
        associates: Array.isArray(body.associates) ? body.associates : [],
        missingFromDer: Array.isArray(body.missingFromDer) ? body.missingFromDer : [],
        requiredForCashEntry: Array.isArray(body.requiredForCashEntry) ? body.requiredForCashEntry : [],
        expectedCash: body.expectedCash && typeof body.expectedCash === "object" ? body.expectedCash : null,
        sessionSource: body.sessionSource == null ? null : String(body.sessionSource)
      };
      writeDriverReconCache(key, payload);
      applyPayload(payload, setters);
      setLoaded(true);
      hydratedKeyRef.current = key;
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      if (!soft) {
        setDrivers([]);
        setReconciliation([]);
        setApiAssociates([]);
        setApiMissingFromDer([]);
        setApiRequired([]);
        setExpectedCash(null);
        setLoaded(false);
      }
      setError(err instanceof Error ? err.message : "Unable to load cash recon drivers.");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [businessDate, locationId, setters, stationCode, workerConfigured]);

  // Fetch when station/date/location/baseline IDs change — not on every save remount.
  useEffect(() => {
    if (!workerConfigured) {
      setLoaded(true);
      return;
    }
    const cached = readDriverReconCache(cacheKey);
    if (cached && hydratedKeyRef.current === cacheKey) {
      return;
    }
    if (cached) {
      applyPayload(cached, setters);
      setLoaded(true);
      setError(null);
      hydratedKeyRef.current = cacheKey;
      return;
    }
    void fetchDriverRecon({ soft: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, workerConfigured]);

  const enriched = useMemo(
    () => enrichCollectCash(dbAssociates, apiAssociates, drivers, reconciliation, expectedCash),
    [apiAssociates, dbAssociates, drivers, expectedCash, reconciliation]
  );

  const missing = useMemo(
    () => mapMissingFromDer(apiMissingFromDer),
    [apiMissingFromDer]
  );

  const requiredForGate = useMemo(() => {
    if (apiRequired.length) {
      return apiRequired.filter((row) => {
        const id = String(row.providerEmployeeId ?? "").trim().toLowerCase();
        return id && id !== "__other__" && Number(row.expected) > 0.01;
      });
    }
    const fromDb = enriched
      .filter((row) => Number(row.expectedAmount) > 0.01)
      .map((row) => toCashReconAssociate(row, "matched"));
    const fromMissing = missing
      .filter((row) => row.providerEmployeeId !== "__other__" && Number(row.expectedAmount) > 0.01)
      .map((row) => toCashReconAssociate(row, "extra"));
    const byId = new Map<string, CashReconAssociate>();
    [...fromDb, ...fromMissing].forEach((row) => byId.set(row.providerEmployeeId.toUpperCase(), row));
    return Array.from(byId.values());
  }, [apiRequired, enriched, missing]);

  const zeroCashReady = useMemo(() => {
    if (!loaded || loading || Boolean(error)) return false;
    const expectedTotal = Number(expectedCash?.totalReceived) || 0;
    if (expectedTotal > 0.01) return false;

    const pendingRows = apiAssociates.length || apiMissingFromDer.length
      ? [...apiAssociates, ...apiMissingFromDer]
      : reconciliation.map((row) => ({
          pendingRecon: moneyValue(row.paymentInfo?.overallPendingRecon)
        }));

    return pendingRows.every((row) => (Number(row.pendingRecon) || 0) <= 0.01);
  }, [apiAssociates, apiMissingFromDer, error, expectedCash, loaded, loading, reconciliation]);

  useRegisterCashStepRequired(requiredForGate, loaded && !loading && !error, zeroCashReady);

  const busy = loading || refreshing || pending;
  const driversReady = !workerConfigured || (loaded && !loading && !error);
  const entryEnabled = canEdit && driversReady;

  return (
    <>
      <section className="panel reconciliation-stage">
        <div className="panel-head">
          <div>
            <span className="stage-kicker">Step 1 of 3</span>
            <h2>Associate cash sheet</h2>
            <p className="subtle">Select one driver or add all available drivers, then enter the expected COD and denomination count.</p>
          </div>
          <span className={`status-pill ${loaded ? "good" : error ? "warn" : ""}`}>
            {busy ? (loaded ? "Updating…" : "Loading…") : loaded ? `${enriched.length} available` : "Idle"}
          </span>
        </div>
        <div className="panel-body reconciliation-cash-source">
          <div className="reconciliation-stage-action">
            <div>
              <strong>{stationCode} · {businessDate}</strong>
              <span>
                {loaded
                  ? `${enriched.length} drivers loaded · ${requiredForGate.length} with expected &gt; 0 · ${savedCount} cash rows saved${sessionSource ? ` · ${sessionSource}` : ""}`
                  : workerConfigured
                    ? (busy
                      ? "Fetching driver reconciliation from cash recon worker…"
                      : "Driver list not loaded yet — click Refresh drivers.")
                    : `${enriched.length} drivers loaded · ${savedCount} cash rows saved`}
              </span>
            </div>
            <button
              className="button secondary"
              type="button"
              disabled={!workerConfigured || !canEdit || busy}
              onClick={() => startTransition(() => { void fetchDriverRecon({ force: true, soft: true }); })}
            >
              {busy ? "Refreshing…" : "Refresh drivers"}
            </button>
          </div>
          {!workerConfigured ? (
            <p className="subtle" style={{ marginTop: 12 }}>
              Set <code>CASH_RECON_WORKER_URL</code> and <code>CASH_RECON_ADMIN_KEY</code> in <code>.env.local</code>.
            </p>
          ) : null}
          {error ? (
            <div className="panel message-panel error" style={{ marginTop: 12 }}>
              <div className="panel-body"><strong>Unable to load cash recon</strong><p className="subtle" style={{ marginTop: 6 }}>{error}</p></div>
            </div>
          ) : null}
          {workerConfigured && !driversReady && !error ? (
            <p className="subtle" style={{ marginTop: 12 }}>
              Collect cash and Add associate missing from DER stay locked until driver denominations finish loading.
            </p>
          ) : null}
        </div>
      </section>

      <section className={`panel${!driversReady && workerConfigured ? " is-disabled" : ""}`}>
        <div className="panel-head">
          <div>
            <h2>Collect cash</h2>
            <p className="subtle">
              {!driversReady && workerConfigured
                ? "Waiting for driver denominations to load…"
                : "Select associate, count denominations and save."}
            </p>
          </div>
          <span className="count-badge">{driversReady ? `${enriched.length} available` : "—"}</span>
        </div>
        {workerConfigured && !driversReady ? (
          <div className="panel-body">
            <p className="subtle">
              {busy
                ? "Loading cash-recon driver list. Collect cash stays idle until denominations are ready."
                : error
                  ? "Fix the load error above, then click Refresh drivers."
                  : "Waiting for cash-recon driver list…"}
            </p>
          </div>
        ) : enriched.length ? (
          <AssociateEntryBuilder
            associates={enriched}
            businessDate={businessDate}
            canEdit={entryEnabled}
            initiallyHiddenProviderIds={savedProviderEmployeeIds}
            locationId={locationId}
            returnHref={returnHref}
            stationCode={stationCode}
            stationLabel={stationLabel}
            emptyHint="No shipment associates found for this station yet."
          />
        ) : (
          <div className="panel-body">
            <p className="subtle">Select one station to load its Amazon associates.</p>
          </div>
        )}
      </section>

      {canAdd ? (
        <MissingDerPanel
          associates={missing}
          businessDate={businessDate}
          canEdit={entryEnabled}
          driversReady={driversReady}
          initiallyHiddenProviderIds={savedProviderEmployeeIds}
          locationId={locationId}
          returnHref={returnHref}
          stationCode={stationCode}
          stationLabel={stationLabel}
        />
      ) : null}
    </>
  );
}

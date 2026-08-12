import { cookies } from "next/headers";
import { CodSectionTabs } from "@/components/cod-section-tabs";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  amountValue,
  codSetupMessage,
  executiveDisplayName,
  executiveReconciliationStatuses,
  formatAmount,
  formatDateTime,
  isMissingCodSetup,
  loadExecutiveReconciliationRows,
  loadPortalCheckRuns,
  locationLabel
} from "@/lib/ops-pulse/cod";
import { isSupabaseAdminConfigured } from "@/lib/supabase-admin";
import {
  continueCodWithPendingDriverReconciliation,
  queueCodClosureCheck,
  requestCodGateException,
  reviewCodGateException,
  submitCodDayClosureForm
} from "./actions";
import { LiveCacheRefresh } from "./live-cache-refresh";
import { loadCodDayClosures, loadCodManagerNotifications } from "@/lib/ops-pulse/cod-day-closure";
import { canAccessCodAudit, loadCodAuditRows } from "@/lib/ops-pulse/cod-audit";
import { PortalCheckProgress } from "./portal-check-progress";
import { DriverReconCashPanel } from "./driver-recon-cash-panel";
import { DepositRemittancePanel } from "./deposit-remittance-panel";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import {
  expectedFromCashReconRaw,
  missingRequiredCashEntries,
  type CashReconAssociate
} from "@/lib/ops-pulse/cash-recon-types";
import { CashSubmissionForm } from "./cash-submission-form";
import { CashCollectionWorkspace } from "./cash-collection-workspace";
import {
  CashStepGateProvider,
  ContinueToDriverValidation,
  DriverValidationNavLink
} from "./cash-step-gate";
import { SavedCashList } from "./saved-cash-list";

function isCashReconWorkerConfigured() {
  return Boolean(
    (process.env.CASH_RECON_WORKER_URL || process.env.NEXT_PUBLIC_CASH_RECON_WORKER_URL || "").trim()
    && (process.env.CASH_RECON_ADMIN_KEY || process.env.X_ADMIN_KEY || "").trim()
  );
}

export const maxDuration = 300;

type SearchParams = {
  date?: string;
  location?: string;
  status?: string;
  step?: string;
};

function loadFlash() {
  const raw = cookies().get("dropx_cod_executive_reconciliation_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

function currentHref(searchParams?: SearchParams) {
  const query = new URLSearchParams();
  if (searchParams?.date) query.set("date", searchParams.date);
  if (searchParams?.location) query.set("location", searchParams.location);
  if (searchParams?.status) query.set("status", searchParams.status);
  if (searchParams?.step) query.set("step", searchParams.step);
  const suffix = query.toString();
  // Public ops host uses /cod/* (middleware rewrites to /ops-pulse/cod/*).
  return `/cod/executive-reconciliation${suffix ? `?${suffix}` : ""}`;
}

function moneyClass(value: number) {
  if (value < 0) return "amount-negative";
  if (value > 0) return "amount-positive";
  return "amount-neutral";
}

function differenceLabel(value: number) {
  if (value < 0) return `Short ${formatAmount(Math.abs(value))}`;
  if (value > 0) return `Excess ${formatAmount(value)}`;
  return "0.00";
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export const dynamic = "force-dynamic";

export default async function ExecutiveReconciliationPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.cod_executive_reconciliation;
  const flash = loadFlash();

  const result = await loadExecutiveReconciliationRows(
    companyId,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess,
    {
      businessDate: searchParams?.date ?? "",
      locationId: searchParams?.location ?? "",
      status: searchParams?.status ?? ""
    }
  );

  const operatingContext = resolveOperatingContext(result.locations);
  const requestedLocationId = searchParams?.location ?? "";
  const defaultLocationId = result.locations.some((location) => location.id === requestedLocationId)
    ? requestedLocationId
    : operatingContext.location?.id ?? "";
  const returnHref = currentHref({
    date: searchParams?.date ?? result.businessDate,
    location: defaultLocationId,
    status: searchParams?.status ?? "",
    step: searchParams?.step ?? "1"
  });
  const resultSetupError = result.error && isMissingCodSetup({ message: result.error }) ? result.error : null;
  const setupError = resultSetupError;
  const selectedStation = result.locations.find((location) => location.id === defaultLocationId);
  const rows = defaultLocationId
    ? result.rows.filter((row) => row.location_id === defaultLocationId || row.station_code === selectedStation?.station_code)
    : result.rows;
  const savedRows = rows.filter((row) => row.reconciliation_id);
  // Collect cash = shipment DB associates only (full names like "Shiva Yadav / DROP / 207546749").
  // Never use cash-recon roster rows here — those belong in Missing from DER when unmatched.
  const availableRows = rows.filter((row) =>
    row.source === "shipment_data"
    && row.source_associate_name
    && !row.reconciliation_id
  );
  const dbAssociates = availableRows.map((row) => ({
    name: String(row.source_associate_name ?? "").trim(),
    providerEmployeeId: String(row.provider_employee_id ?? "").trim(),
    shipmentType: row.shipment_type ?? "Shipment data",
    pendingAmount: 0,
    expectedAmount: 0,
    pendingRecon: 0,
    breakdown: [] as Array<{
      trackingId: string;
      paymentMethod: string;
      moneyCollectionTime: number | null;
      amount: number;
      stationTimeZone: string;
    }>
  })).filter((row) => row.providerEmployeeId && row.name);
  const completed = savedRows.filter((row) => row.reconciliation_status === "Completed").length;
  const expectedTotal = savedRows.reduce((sum, row) => sum + amountValue(row.expected_amount), 0);
  const collectedTotal = savedRows.reduce((sum, row) => sum + amountValue(row.collected_amount), 0);
  const netDifference = savedRows.reduce((sum, row) => sum + amountValue(row.difference_amount), 0);
  const hasSingleStationScope = result.locations.length <= 1;
  const sccRows = rows.filter((row) => row.source === "scc_driver_reconciliation").length;
  const cashReconReady = isCashReconWorkerConfigured();
  const automationReady = cashReconReady && isSupabaseAdminConfigured;
  const auditAllowed = canAccessCodAudit(authorization);
  const [closures, managerNotifications, auditRows, portalRunsResult] = await Promise.all([
    loadCodDayClosures(companyId, result.businessDate, result.locations.map((location) => location.id)),
    loadCodManagerNotifications(companyId, result.locations.map((location) => location.id)),
    auditAllowed
      ? loadCodAuditRows(companyId, result.locations.map((location) => location.id), result.businessDate, defaultLocationId)
      : Promise.resolve([]),
    loadPortalCheckRuns(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess, {
      checkDate: result.businessDate,
      locationId: defaultLocationId
    })
  ]);
  const driverRun = portalRunsResult.rows.find((run) => run.check_type === "driver_reconciliation");
  const depositRun = portalRunsResult.rows.find((run) => run.check_type === "prepared_deposit");
  const hasActivePortalCheck = [driverRun, depositRun].some((run) =>
    run && ["Queued", "Running", "Manual Review", "Error"].includes(run.status) && Number(run.attempt_count ?? 0) < 3
  );
  const selectedClosure = closures.find((closure) => closure.location_id === defaultLocationId) ?? null;
  const closureSnapshot = objectValue(selectedClosure?.validation_snapshot);
  const cashSubmissionSnapshot = objectValue(closureSnapshot.cash_submission);
  const remittanceSnapshot = objectValue(closureSnapshot.remittance);
  const remittanceOverrideRemarks = String(remittanceSnapshot.override_remarks ?? "").trim();
  const cashSubmitted = Boolean(cashSubmissionSnapshot.submitted_at) && selectedClosure?.submission_status !== "Draft";
  const submittedDifference = amountValue(String(cashSubmissionSnapshot.difference_amount ?? 0));
  const cashSubmissionStatus = !cashSubmitted
    ? "Draft"
    : submittedDifference < 0
      ? "Submitted with shortage"
      : submittedDifference > 0
        ? "Submitted with excess"
        : "Submitted";
  const currentVarianceType = netDifference < 0 ? "short" : netDifference > 0 ? "excess" : "balanced";
  const currentVarianceLabel = netDifference < 0
    ? `COD short ${formatAmount(Math.abs(netDifference))}`
    : netDifference > 0
      ? `COD excess ${formatAmount(netDifference)}`
      : "No COD variance";
  const driverCleared = selectedClosure?.driver_check_status === "Passed" ||
    selectedClosure?.driver_check_status === "Exception approved";
  const driverDisplayStatus = driverRun?.status === "Pass"
    ? "Driver recon cleared"
    : driverRun?.status === "Fail"
      ? `Pending recon found${Number(driverRun.pending_count ?? 0) ? ` · ${driverRun.pending_count}` : ""}`
      : driverRun?.status === "Error"
        ? "Validation unavailable"
        : driverRun?.status === "Manual Review"
          ? "Manual login required"
      : selectedClosure?.driver_exception_reason?.startsWith("Continued with SCC pending.")
        ? "Continued with pending · notified"
        : selectedClosure?.driver_check_status ?? "Not run";
  const depositAmountDifference = Number((
    collectedTotal - amountValue(selectedClosure?.amazon_open_remittance_expected)
  ).toFixed(2));
  const depositMatched = selectedClosure?.deposit_check_status === "Passed" &&
    selectedClosure.no_deposit_liability &&
    selectedClosure.amazon_open_remittance_count > 0 &&
    Math.abs(depositAmountDifference) <= 1;
  const remittanceDepositCleared = cashReconReady && (
    selectedClosure?.deposit_check_status === "Passed" ||
    selectedClosure?.deposit_check_status === "Exception approved"
  );
  const depositCleared = cashReconReady
    ? Boolean(remittanceDepositCleared)
    : depositMatched || selectedClosure?.deposit_check_status === "Exception approved";
  const depositDisplayStatus = cashReconReady
    ? (depositCleared ? "Passed" : selectedClosure?.deposit_check_status ?? "Not validated")
    : selectedClosure?.deposit_check_status === "Passed" && !depositMatched
      ? "Pending"
      : selectedClosure?.deposit_check_status ?? "Locked";
  const canManagerReview = auditAllowed;
  const requestedStep = ["1", "2", "3"].includes(String(searchParams?.step)) ? Number(searchParams?.step) : 1;
  const savedProviderEmployeeIds = savedRows
    .map((row) => String(row.provider_employee_id ?? "").trim())
    .filter(Boolean);
  const gateSavedEntries = savedRows.map((row) => ({
    providerEmployeeId: String(row.provider_employee_id ?? "").trim(),
    name: executiveDisplayName(row)
  }));
  // Prefer cash-recon worker rows when present; also treat saved expected>0 rows as required
  // so unmapped / Missing-DER saves unlock Step 2 even when the DB roster was never stamped.
  const requiredFromRoster = rows.filter((row) => {
    const id = String(row.provider_employee_id ?? "").trim();
    if (!id || id === "__other__") return false;
    const raw = row.scc_raw_row as Record<string, unknown> | null;
    if (raw?.source !== "cash_recon_worker") return false;
    return expectedFromCashReconRaw(raw) > 0.01;
  });
  const requiredFromSaved = savedRows.filter((row) => {
    const id = String(row.provider_employee_id ?? "").trim();
    return id && id !== "__other__" && amountValue(row.expected_amount) > 0.01;
  });
  const requiredSource = requiredFromRoster.length ? requiredFromRoster : requiredFromSaved;
  const initialRequiredAssociates: CashReconAssociate[] = requiredSource.map((row) => ({
    providerEmployeeId: String(row.provider_employee_id ?? "").trim(),
    name: String(row.source_associate_name ?? "").trim() || executiveDisplayName(row),
    displayName: String(row.source_associate_name ?? "").trim() || executiveDisplayName(row),
    employeeId: null,
    expected: requiredFromRoster.length
      ? expectedFromCashReconRaw(row.scc_raw_row as Record<string, unknown> | null)
      : amountValue(row.expected_amount),
    pendingRecon: amountValue(row.scc_pending_amount ?? row.pending_amount),
    breakdown: [],
    source: "matched",
    shipmentType: String(row.shipment_type ?? "Shipment data")
  }));
  const missingServerRequired = missingRequiredCashEntries(initialRequiredAssociates, gateSavedEntries);
  // Match client gate: all required cash entered, or no required list + navigating to step 2 (zero-cash day).
  const cashReady = cashReconReady
    ? missingServerRequired.length === 0
      && (initialRequiredAssociates.length > 0 || savedRows.length > 0 || requestedStep >= 2)
    : savedRows.length > 0;
  const activeStep = requestedStep >= 3 && !driverCleared
    ? cashReady ? 2 : 1
    : requestedStep >= 2 && !cashReady
      ? 1
      : requestedStep;
  const stepHref = (step: number) => currentHref({
    date: result.businessDate,
    location: defaultLocationId,
    status: searchParams?.status ?? "",
    step: String(step)
  });
  return (
    <>
      <PageHead
        eyebrow="Ops Pulse"
        title="Executive Reconciliation"
        subtitle="Count cash, validate SCC and close the station day."
        action={<span className={`status-pill ${automationReady ? "good" : "warn"}`}>{automationReady ? "Automation ready" : "Setup required"}</span>}
      />
      <CodSectionTabs active="executive-reconciliation" />

      {setupError ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {codSetupMessage(setupError)} Also run scripts/cod_executive_reconciliation_denominations_v2.sql.
            </p>
          </div>
        </section>
      ) : null}

      {!setupError && result.error ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Unable to load executive reconciliation</strong><p className="subtle" style={{ marginTop: 6 }}>{result.error}</p></div>
        </section>
      ) : null}

      {!setupError && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body"><strong>{flash.error ? "Action required" : "Completed"}</strong><p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p></div>
        </section>
      ) : null}

      {!setupError ? (
        <CashStepGateProvider
          initialRequired={initialRequiredAssociates}
          mode={cashReconReady ? "cash-recon" : "legacy"}
          savedCount={savedRows.length}
          savedEntries={savedRows.map((row) => ({
            providerEmployeeId: String(row.provider_employee_id ?? "").trim(),
            name: executiveDisplayName(row)
          }))}
          step2Href={stepHref(2)}
        >
          <LiveCacheRefresh active={hasActivePortalCheck} />
          <section className="panel reconciliation-control-bar">
            <div className="panel-body">
              <form action="/ops-pulse/cod/executive-reconciliation" className="form-grid cod-reconciliation-filter-grid">
                <label>Business Date<input className="field" name="date" type="date" defaultValue={result.businessDate} /></label>
                <label className="span-2">Station
                  <select className="field" name="location" defaultValue={defaultLocationId} disabled={hasSingleStationScope}>
                    {!hasSingleStationScope ? <option value="">Select station</option> : null}
                    {result.locations.map((location) => <option key={location.id} value={location.id}>{locationLabel(location)}</option>)}
                  </select>
                  {hasSingleStationScope ? <input type="hidden" name="location" value={defaultLocationId} /> : null}
                </label>
                <label>Status
                  <select className="field" name="status" defaultValue={searchParams?.status ?? ""}>
                    <option value="">All statuses</option>
                    {executiveReconciliationStatuses.map((status) => <option key={status}>{status}</option>)}
                  </select>
                </label>
                <input type="hidden" name="step" value="1" />
                <div className="form-actions cod-filter-actions align-right">
                  <button className="button secondary" type="submit">Apply</button>
                </div>
              </form>
            </div>
          </section>

          <nav className="reconciliation-wizard" aria-label="Executive reconciliation steps">
            <a className={`${activeStep === 1 ? "current" : ""} ${cashReady ? "complete" : ""}`} href={stepHref(1)}>
              <i>1</i><span><strong>Cash sheet</strong><small>Select drivers and count cash</small></span>
            </a>
            <DriverValidationNavLink
              className={`${activeStep === 2 ? "current" : ""} ${driverCleared ? "complete" : ""}`}
              href={stepHref(2)}
              lockedHref={stepHref(1)}
            >
              <i>2</i><span><strong>Driver validation</strong><small>Submit COD and check SCC</small></span>
            </DriverValidationNavLink>
            <a className={`${activeStep === 3 ? "current" : ""} ${selectedClosure?.is_final_submitted ? "complete" : ""} ${!driverCleared ? "locked" : ""}`} href={driverCleared ? stepHref(3) : stepHref(cashReady ? 2 : 1)} aria-disabled={!driverCleared}>
              <i>3</i><span><strong>Deposit & summary</strong><small>Match bank deposit and close</small></span>
            </a>
          </nav>

          {activeStep === 1 && defaultLocationId && selectedStation ? (
            <CashCollectionWorkspace
              dbAssociates={dbAssociates}
              businessDate={result.businessDate}
              canAdd={permission.canAdd}
              canEdit={permission.canEdit && !selectedClosure?.is_final_submitted}
              locationId={defaultLocationId}
              returnHref={returnHref}
              savedProviderEmployeeIds={savedProviderEmployeeIds}
              savedCount={savedRows.length}
              stationCode={selectedStation.station_code}
              stationLabel={selectedStation.station_name ?? selectedStation.state ?? ""}
              workerConfigured={cashReconReady}
            />
          ) : activeStep === 1 ? (
            <section className="panel reconciliation-stage">
              <div className="panel-head">
                <div><span className="stage-kicker">Step 1 of 3</span><h2>Associate cash sheet</h2><p className="subtle">Select one station to load drivers from the cash recon worker.</p></div>
              </div>
              <div className="panel-body"><p className="subtle">Select one station to load its Amazon associates.</p></div>
            </section>
          ) : null}

          <section className={`summary-grid reconciliation-summary ${activeStep === 1 ? "reconciliation-step-hidden" : ""}`}>
            <div className="metric-card"><span>Associates</span><strong>{rows.length}</strong><small>{sccRows ? `${sccRows} validated in SCC` : "From station shipment data"}</small></div>
            <div className="metric-card"><span>Cash entered</span><strong>{savedRows.length}</strong><small>{completed} balanced</small></div>
            <div className="metric-card"><span>Collected</span><strong>{formatAmount(collectedTotal)}</strong><small>Expected {formatAmount(expectedTotal)}</small></div>
            <div className="metric-card"><span>COD variance</span><strong className={moneyClass(netDifference)}>{differenceLabel(netDifference)}</strong><small>Short or excess can be submitted</small></div>
          </section>

          <section className={`panel reconciliation-closure-panel ${activeStep !== 2 && activeStep !== 3 ? "reconciliation-step-hidden" : ""}`}>
            <div className="panel-head">
              <div>
                <h2>{activeStep === 2 ? "Submit cash & validate drivers" : "Bank deposit & closure summary"}</h2>
                <p className="subtle">{selectedStation ? `${selectedStation.station_code} · ${result.businessDate}` : "Select a station"}</p>
              </div>
              <StatusPill status={selectedClosure?.is_final_submitted ? "Final submitted" : cashSubmissionStatus} />
            </div>
            <div className="panel-body">
              {activeStep === 3 ? (
                <section className="reconciliation-final-summary">
                  <div><span>Cash submitted</span><strong>{formatAmount(collectedTotal)}</strong><small>{currentVarianceLabel}</small></div>
                  <div><span>SCC driver check</span><strong>{driverDisplayStatus}</strong><small>{Number(driverRun?.pending_count ?? 0)} pending · {formatAmount(driverRun?.pending_amount)}</small></div>
                  <div><span>Bank expected</span><strong>{formatAmount(selectedClosure?.amazon_open_remittance_expected)}</strong><small>{selectedClosure?.amazon_open_remittance_count ?? 0} open remittances</small></div>
                  <div><span>Deposit difference</span><strong className={moneyClass(depositAmountDifference)}>{differenceLabel(depositAmountDifference)}</strong><small>{depositDisplayStatus}</small></div>
                </section>
              ) : null}
              <div className="reconciliation-lifecycle reconciliation-step-hidden" aria-label="COD closure lifecycle">
                <div className={savedRows.length ? "complete" : "current"}><i>1</i><span>Cash sheet</span><strong>{savedRows.length ? `${savedRows.length} entered` : "Start"}</strong></div>
                <div className={cashSubmitted ? "complete" : savedRows.length ? "current" : ""}><i>2</i><span>Submit COD</span><strong>{cashSubmissionStatus}</strong></div>
                <div className={driverCleared ? "complete" : cashSubmitted ? "current" : ""}><i>3</i><span>Driver recon</span><strong>{driverDisplayStatus}</strong></div>
                <div className={selectedClosure?.is_final_submitted ? "complete" : driverCleared ? "current" : ""}><i>4</i><span>Deposit & close</span><strong>{selectedClosure?.is_final_submitted ? "Closed" : depositDisplayStatus}</strong></div>
              </div>
              {defaultLocationId ? (
                <>
                  <section className={`cash-submission-card ${currentVarianceType} ${activeStep !== 2 ? "reconciliation-step-hidden" : ""}`}>
                    <div>
                      <span>Cash submission</span>
                      <strong>{currentVarianceLabel}</strong>
                      <small>
                        Expected {formatAmount(expectedTotal)} · Collected {formatAmount(collectedTotal)}
                        {cashSubmitted ? ` · Last submitted ${formatDateTime(String(cashSubmissionSnapshot.submitted_at ?? ""))}` : ""}
                      </small>
                    </div>
                    <CashSubmissionForm
                      businessDate={result.businessDate}
                      disabled={!permission.canEdit || !savedRows.length || Boolean(selectedClosure?.is_final_submitted)}
                      locationId={defaultLocationId}
                      returnHref={returnHref}
                      stationCode={selectedStation?.station_code ?? ""}
                      varianceLabel={currentVarianceLabel}
                      varianceType={currentVarianceType}
                      workerConfigured={cashReconReady}
                    />
                  </section>
                  {activeStep === 2 && cashSubmitted && submittedDifference !== 0 ? (
                    <div className="cash-exception-strip">
                      <StatusPill status={cashSubmissionStatus} />
                      <span>
                        Manager notification: {selectedClosure?.manager_status === "Pending" ? "sent / pending review" : selectedClosure?.manager_status ?? "pending"}.
                        Driver Reconciliation continues independently.
                      </span>
                    </div>
                  ) : null}
                  <div className="reconciliation-gates">
                  <section className={`reconciliation-gate ${activeStep !== 2 ? "reconciliation-step-hidden" : ""}`}>
                    <div className="reconciliation-gate-head">
                      <div><span>Validation 1</span><strong>Driver reconciliation</strong></div>
                      {cashReconReady ? null : <StatusPill status={driverDisplayStatus} />}
                    </div>
                    {cashReconReady && selectedStation ? (
                      <DriverReconCashPanel
                        stationCode={selectedStation.station_code}
                        businessDate={result.businessDate}
                        locationId={defaultLocationId}
                        canRefresh={permission.canEdit && !selectedClosure?.is_final_submitted}
                        cashSubmitted={cashSubmitted}
                      />
                    ) : (
                      <>
                        <PortalCheckProgress
                          attemptCount={Number(driverRun?.attempt_count ?? 0)}
                          checkLabel="SCC Driver Reconciliation"
                          lastCheckedAt={driverRun?.last_checked_at ?? null}
                          nextCheckAt={driverRun?.next_check_at ?? null}
                          summary={driverRun?.summary ?? null}
                          status={driverRun?.status ?? "Not run"}
                        />
                        <form action={queueCodClosureCheck} className="form-actions" style={{ marginTop: 12 }}>
                          <input type="hidden" name="return_href" value={returnHref} />
                          <input type="hidden" name="business_date" value={result.businessDate} />
                          <input type="hidden" name="location_id" value={defaultLocationId} />
                          <input type="hidden" name="check_type" value="driver_reconciliation" />
                          <SubmitButton className="button secondary" disabled={!permission.canEdit || !cashSubmitted || selectedClosure?.is_final_submitted}>
                            {cashSubmitted ? "Recheck SCC" : "Submit cash first"}
                          </SubmitButton>
                        </form>
                      </>
                    )}
                    {selectedClosure && ["Pending", "Manual Review", "Error", "Exception rejected"].includes(selectedClosure.driver_check_status) ? (
                      <details className="reconciliation-exception">
                        <summary>Continue with SCC pending</summary>
                        <form action={continueCodWithPendingDriverReconciliation} className="form-grid three">
                          <input type="hidden" name="return_href" value={returnHref} />
                          <input type="hidden" name="business_date" value={result.businessDate} />
                          <input type="hidden" name="location_id" value={defaultLocationId} />
                          <label className="span-2">Reason<textarea className="field" name="exception_reason" rows={2} placeholder="Why the station is proceeding with SCC pending" required /></label>
                          <div className="form-actions align-right"><SubmitButton>Continue & notify</SubmitButton></div>
                        </form>
                      </details>
                    ) : null}
                    {selectedClosure?.driver_check_status === "Exception requested" ? (
                      <div className="alert danger" style={{ marginTop: 12 }}>
                        <strong>Manager approval pending</strong>
                        <span>{selectedClosure.driver_exception_reason}</span>
                      </div>
                    ) : null}
                    {selectedClosure?.driver_check_status === "Exception requested" && canManagerReview ? (
                      <form action={reviewCodGateException} className="form-grid three" style={{ marginTop: 12 }}>
                        <input type="hidden" name="return_href" value={returnHref} />
                        <input type="hidden" name="closure_id" value={selectedClosure.id} />
                        <input type="hidden" name="gate" value="driver" />
                        <label className="span-2">Manager remarks<input className="field" name="manager_remarks" placeholder="Approval or rejection remarks" /></label>
                        <div className="form-actions align-right">
                          <button className="button secondary" name="decision" value="reject">Reject</button>
                          <button className="button" name="decision" value="approve">Approve exception</button>
                        </div>
                      </form>
                    ) : null}
                  </section>

                  {cashReconReady && selectedStation ? (
                    <div className={activeStep !== 3 ? "reconciliation-step-hidden" : ""}>
                      <DepositRemittancePanel
                        stationCode={selectedStation.station_code}
                        businessDate={result.businessDate}
                        locationId={defaultLocationId}
                        returnHref={returnHref}
                        collectedCash={collectedTotal}
                        canEdit={permission.canEdit}
                        driverCleared={Boolean(driverCleared)}
                        isFinalSubmitted={Boolean(selectedClosure?.is_final_submitted)}
                        depositAlreadyCleared={Boolean(depositCleared)}
                        initialOverrideRemarks={remittanceOverrideRemarks}
                      />
                    </div>
                  ) : (
                    <>
                      <section className={`reconciliation-gate ${!driverCleared ? "locked" : ""} ${activeStep !== 3 ? "reconciliation-step-hidden" : ""}`}>
                        <div className="reconciliation-gate-head">
                          <div><span>Validation 2</span><strong>Bank deposit</strong></div>
                          <StatusPill status={depositDisplayStatus} />
                        </div>
                        <PortalCheckProgress
                          attemptCount={Number(depositRun?.attempt_count ?? 0)}
                          checkLabel="SCC Bank Deposit"
                          lastCheckedAt={depositRun?.last_checked_at ?? null}
                          nextCheckAt={depositRun?.next_check_at ?? null}
                          summary={depositRun?.summary ?? null}
                          status={driverCleared ? depositRun?.status ?? "Not run" : "Locked"}
                        />
                        <form action={queueCodClosureCheck} className="form-actions" style={{ marginTop: 12 }}>
                          <input type="hidden" name="return_href" value={returnHref} />
                          <input type="hidden" name="business_date" value={result.businessDate} />
                          <input type="hidden" name="location_id" value={defaultLocationId} />
                          <input type="hidden" name="check_type" value="prepared_deposit" />
                          <SubmitButton className="button secondary" disabled={!permission.canEdit || !driverCleared || selectedClosure?.is_final_submitted}>
                            {driverCleared ? "Validate deposit" : "Driver recon required"}
                          </SubmitButton>
                        </form>
                        {selectedClosure && ["Pending", "Error", "Exception rejected"].includes(depositDisplayStatus) ? (
                          <details className="reconciliation-exception">
                            <summary>Request exception</summary>
                            <form action={requestCodGateException} className="form-grid three">
                              <input type="hidden" name="return_href" value={returnHref} />
                              <input type="hidden" name="business_date" value={result.businessDate} />
                              <input type="hidden" name="location_id" value={defaultLocationId} />
                              <input type="hidden" name="gate" value="deposit" />
                              <label className="span-2">Reason<textarea className="field" name="exception_reason" rows={2} required /></label>
                              <div className="form-actions align-right"><SubmitButton>Send to manager</SubmitButton></div>
                            </form>
                          </details>
                        ) : null}
                        {selectedClosure?.deposit_check_status === "Exception requested" ? (
                          <div className="alert danger" style={{ marginTop: 12 }}>
                            <strong>Manager approval pending</strong>
                            <span>{selectedClosure.deposit_exception_reason}</span>
                          </div>
                        ) : null}
                        {selectedClosure?.deposit_check_status === "Exception requested" && canManagerReview ? (
                          <form action={reviewCodGateException} className="form-grid three" style={{ marginTop: 12 }}>
                            <input type="hidden" name="return_href" value={returnHref} />
                            <input type="hidden" name="closure_id" value={selectedClosure.id} />
                            <input type="hidden" name="gate" value="deposit" />
                            <label className="span-2">Manager remarks<input className="field" name="manager_remarks" placeholder="Approval or rejection remarks" /></label>
                            <div className="form-actions align-right">
                              <button className="button secondary" name="decision" value="reject">Reject</button>
                              <button className="button" name="decision" value="approve">Approve exception</button>
                            </div>
                          </form>
                        ) : null}
                      </section>

                      <section className={`reconciliation-gate final ${!depositCleared ? "locked" : ""} ${activeStep !== 3 ? "reconciliation-step-hidden" : ""}`}>
                        <div className="reconciliation-gate-head">
                          <div><span>Final</span><strong>Close station day</strong></div>
                          <StatusPill status={selectedClosure?.is_final_submitted ? "Final submitted" : "Pending"} />
                        </div>
                        <p className="subtle">Final close locks all cash entries.</p>
                        <form action={submitCodDayClosureForm} className="form-actions" style={{ marginTop: 12 }}>
                          <input type="hidden" name="return_href" value={returnHref} />
                          <input type="hidden" name="business_date" value={result.businessDate} />
                          <input type="hidden" name="location_id" value={defaultLocationId} />
                          <SubmitButton disabled={!permission.canEdit || !driverCleared || !depositCleared || selectedClosure?.is_final_submitted}>
                            {selectedClosure?.is_final_submitted ? "Final submitted and locked" : "Submit final COD closure"}
                          </SubmitButton>
                        </form>
                      </section>
                    </>
                  )}
                </div>
                </>
              ) : <p className="subtle">Select one station to submit its day closure.</p>}
              {activeStep === 3 && managerNotifications.length ? (
                <details className="reconciliation-support-panel">
                  <summary>Manager notifications ({managerNotifications.length})</summary>
                  <div className="table-wrap">
                  <table>
                    <thead><tr><th>Created</th><th>Manager notification</th><th>Portal</th><th>Email</th></tr></thead>
                    <tbody>
                      {managerNotifications.map((notification) => (
                        <tr key={notification.id}>
                          <td>{formatDateTime(notification.created_at)}</td>
                          <td><strong>{notification.title}</strong><br /><span className="subtle">{notification.message}</span></td>
                          <td><StatusPill status={notification.status} /></td>
                          <td><StatusPill status={notification.email_status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </details>
              ) : null}
            </div>
          </section>

          <section className={`panel ${activeStep !== 1 ? "reconciliation-step-hidden" : ""}`}>
            <div className="panel-head">
              <div>
                <h2>Saved cash</h2>
                <p className="subtle">Edit or delete before final close.</p>
              </div>
              <span className="count-badge">{savedRows.length} entries</span>
            </div>
            <SavedCashList
              rows={savedRows}
              canEdit={permission.canEdit}
              isFinalSubmitted={Boolean(selectedClosure?.is_final_submitted)}
              returnHref={returnHref}
            />
            {activeStep === 1 ? <ContinueToDriverValidation /> : null}
          </section>

          {activeStep === 3 && auditAllowed ? (
            <details className="panel reconciliation-support-panel">
              <summary>Activity history ({auditRows.length})</summary>
              <div className="reconciliation-support-toolbar">
                <span className="subtle">Entries, edits, deletions, checks and approvals</span>
                <a className="button secondary" href={`/api/ops-pulse/cod/audit-export?date=${encodeURIComponent(result.businessDate)}${defaultLocationId ? `&location=${encodeURIComponent(defaultLocationId)}` : ""}`}>Download CSV</a>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Time</th><th>Station</th><th>Associate</th><th>Action</th><th>Changed fields</th><th>Performed by</th></tr></thead>
                  <tbody>
                    {auditRows.length ? auditRows.map((audit) => (
                      <tr key={audit.id}>
                        <td>{formatDateTime(audit.created_at)}</td>
                        <td>{audit.station_code}</td>
                        <td>{audit.associate_name ?? audit.provider_employee_id ?? "-"}</td>
                        <td><strong>{audit.action}</strong></td>
                        <td>{Array.isArray(audit.changed_fields) && audit.changed_fields.length ? audit.changed_fields.join(", ") : "-"}</td>
                        <td>{audit.actor_name ?? audit.actor_email ?? audit.actor_role ?? "-"}</td>
                      </tr>
                    )) : (
                      <tr><td className="empty-cell" colSpan={6}>No audited COD activity for this selection yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </CashStepGateProvider>
      ) : null}
    </>
  );
}

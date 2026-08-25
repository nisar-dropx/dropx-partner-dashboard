import Link from "next/link";
import { CodSectionTabs } from "@/components/cod-section-tabs";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  amountValue,
  codPeriod,
  codSetupMessage,
  depositAttachmentsFor,
  depositSlipViewUrl,
  firstRelation,
  formatAmount,
  formatDate,
  formatDateTime,
  formTypeLabel,
  inferFormTypeFromLocation,
  isMissingCodSetup,
  loadCodCashActivity,
  loadCodLocations,
  loadCodSubmissions,
  locationLabel,
  type CodCashActivitySummary,
  type CodLocationRow,
  type CodSubmissionRow
} from "@/lib/ops-pulse/cod";
import {
  codClosureStageLabel,
  daysBetweenYmd,
  loadFinalCodDayClosures,
  remittanceCodesFromClosure,
  remittanceExpectedFromClosure,
  yesterdayKolkata,
  type CodDayClosure
} from "@/lib/ops-pulse/cod-day-closure";
import { isSupabaseAdminConfigured } from "@/lib/supabase-admin";

type SearchParams = {
  client?: string;
  from?: string;
  location?: string;
  status?: string;
  to?: string;
};

type StationDayRow = {
  key: string;
  date: string;
  locationId: string;
  stationLabel: string;
  stationCode: string;
  client: string;
  erCollected: number | null;
  erRemittance: number | null;
  submittedAmount: number | null;
  remittanceCode: string;
  slipUrl: string | null;
  status: string;
  variance: number | null;
  remarks: string;
  submissionId: string | null;
};

type StationFocusRow = {
  key: string;
  locationId: string;
  stationLabel: string;
  stationCode: string;
  status: string;
  collected: number | null;
  entryCount: number;
  actionHref: string;
};

/** Pipeline status for one station on the focus date, whether or not it ever reached a closure row. */
function buildStationFocusRow(
  location: CodLocationRow,
  closure: CodDayClosure | null,
  activity: CodCashActivitySummary | null,
  focusDate: string
): StationFocusRow {
  const stationLabel = locationLabel(location) || location.station_code || "-";
  const hrefFor = (step: number) =>
    `/ops-pulse/cod/executive-reconciliation?date=${encodeURIComponent(focusDate)}&location=${encodeURIComponent(location.id)}&step=${step}`;
  if (closure) {
    const status = closure.is_final_submitted ? "Final submitted" : codClosureStageLabel(closure);
    const step = closure.is_final_submitted
      ? 3
      : closure.driver_check_status === "Passed" || closure.driver_check_status === "Exception approved"
        ? 3
        : 2;
    return {
      key: `closure:${closure.id}`,
      locationId: location.id,
      stationLabel,
      stationCode: location.station_code,
      status,
      collected: amountValue(closure.collected_cod),
      entryCount: 0,
      actionHref: closure.is_final_submitted ? "" : hrefFor(step)
    };
  }
  if (activity && activity.entryCount > 0) {
    return {
      key: `activity:${location.id}`,
      locationId: location.id,
      stationLabel,
      stationCode: location.station_code,
      status: "Cash entered — submission pending",
      collected: activity.collectedTotal,
      entryCount: activity.entryCount,
      actionHref: hrefFor(1)
    };
  }
  return {
    key: `none:${location.id}`,
    locationId: location.id,
    stationLabel,
    stationCode: location.station_code,
    status: "Missing — cash sheet not started",
    collected: null,
    entryCount: 0,
    actionHref: hrefFor(1)
  };
}

/** Sort order for the focus-date table: most actionable (nothing done yet) first, closed days last. */
function statusUrgency(status: string) {
  if (status === "Missing — cash sheet not started") return 0;
  if (status === "Cash entered — submission pending") return 1;
  if (status.includes("exception")) return 2;
  if (status === "Driver check pending") return 3;
  if (status === "Deposit check pending") return 4;
  if (status === "Ready to finalize") return 5;
  return 6; // Final submitted
}

function submissionMatchesClosure(submission: CodSubmissionRow, closure: CodDayClosure) {
  if (submission.location_id !== closure.location_id) return false;
  const deposit = String(submission.deposit_date ?? "").slice(0, 10);
  const from = String(submission.cod_period_from ?? submission.cod_date ?? "").slice(0, 10);
  const to = String(submission.cod_period_to ?? from).slice(0, 10);
  const business = closure.business_date;
  if (deposit === business) return true;
  if (from && to && business >= from && business <= to) return true;
  return false;
}

function stationDayStatus(params: {
  closure: CodDayClosure | null;
  submission: CodSubmissionRow | null;
}): string {
  const { closure, submission } = params;
  // Closure exists but the station hasn't finished the reconciliation pipeline yet
  // (submit → driver check → deposit check → final close) — show exactly where it's stuck
  // instead of hiding the row until it happens to reach final submit.
  if (closure && !closure.is_final_submitted) return codClosureStageLabel(closure);
  if (closure && !submission) return "Pending submission";
  if (!submission) return "No data";
  const validation = String(submission.validation_status ?? "Pending");
  if (validation === "Matched") return "Verified";
  if (["Short", "Excess", "Rejected"].includes(validation)) return validation;
  if (closure) return "Submitted";
  return validation || "Submitted";
}

function buildStationDayRows(
  closures: CodDayClosure[],
  submissions: CodSubmissionRow[],
  locationById: Map<string, CodLocationRow>,
  statusFilter: string
) {
  const usedSubmissionIds = new Set<string>();
  const rows: StationDayRow[] = [];

  for (const closure of closures) {
    const location = locationById.get(closure.location_id);
    const match = submissions.find((submission) => {
      if (usedSubmissionIds.has(submission.id)) return false;
      return submissionMatchesClosure(submission, closure);
    }) ?? null;
    if (match) usedSubmissionIds.add(match.id);

    const erCollected = amountValue(closure.collected_cod);
    const erRemittance = remittanceExpectedFromClosure(closure);
    const submittedAmount = match ? amountValue(match.deposited_amount ?? match.remittance_amount) : null;
    const codes = remittanceCodesFromClosure(closure);
    const remittanceCode = match?.remittance_code || match?.reference_no || codes[0] || "-";
    const slips = match ? depositAttachmentsFor(match) : [];
    const variance =
      submittedAmount != null ? Number((submittedAmount - erCollected).toFixed(2)) : null;
    const status = stationDayStatus({ closure, submission: match });

    if (statusFilter) {
      const needle = statusFilter.toLowerCase();
      const ok =
        status.toLowerCase().includes(needle) ||
        (needle === "pending" && status === "Pending submission") ||
        (needle === "in_progress" && !closure.is_final_submitted) ||
        (match && String(match.validation_status).toLowerCase() === needle);
      if (!ok) continue;
    }

    rows.push({
      key: `closure:${closure.id}`,
      date: closure.business_date,
      locationId: closure.location_id,
      stationLabel: locationLabel(location) || closure.station_code || "-",
      stationCode: closure.station_code,
      client: formTypeLabel(inferFormTypeFromLocation(location) || "amazon"),
      erCollected,
      erRemittance,
      submittedAmount,
      remittanceCode,
      slipUrl: match && slips.length ? depositSlipViewUrl(match.id) : null,
      status,
      variance,
      remarks: match?.remarks || match?.validation_remarks || closure.override_reason || "-",
      submissionId: match?.id ?? null
    });
  }

  // Submissions without an ER closure (Flipkart / orphan Amazon slips)
  for (const submission of submissions) {
    if (usedSubmissionIds.has(submission.id)) continue;
    const location = firstRelation(submission.stations) || locationById.get(submission.location_id || "");
    const date = String(submission.deposit_date || submission.cod_period_from || submission.cod_date || "").slice(0, 10);
    const submittedAmount = amountValue(submission.deposited_amount ?? submission.remittance_amount);
    const slips = depositAttachmentsFor(submission);
    const status = stationDayStatus({ closure: null, submission });
    if (statusFilter) {
      const needle = statusFilter.toLowerCase();
      const ok =
        status.toLowerCase().includes(needle) ||
        String(submission.validation_status).toLowerCase() === needle;
      if (!ok) continue;
    }
    rows.push({
      key: `submission:${submission.id}`,
      date,
      locationId: submission.location_id || "",
      stationLabel: locationLabel(location) || submission.station_code || "-",
      stationCode: submission.station_code || "",
      client: submission.client ?? formTypeLabel(submission.form_type),
      erCollected: null,
      erRemittance: null,
      submittedAmount,
      remittanceCode: submission.remittance_code || submission.reference_no || "-",
      slipUrl: slips.length ? depositSlipViewUrl(submission.id) : null,
      status,
      variance: null,
      remarks: submission.remarks || submission.validation_remarks || "-",
      submissionId: submission.id
    });
  }

  rows.sort((a, b) => {
    const dateCmp = String(b.date).localeCompare(String(a.date));
    if (dateCmp) return dateCmp;
    return a.stationLabel.localeCompare(b.stationLabel);
  });
  return rows;
}

export const dynamic = "force-dynamic";

export default async function CodReportsPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cod_reports", "access");
  const companyId = requireCompanyId(authorization);
  const selectedClient = searchParams?.client === "amazon" || searchParams?.client === "flipkart" ? searchParams.client : "";
  const yesterday = yesterdayKolkata();
  const fromDate = searchParams?.from ?? "";
  const toDate = searchParams?.to ?? "";
  const locationFilter = searchParams?.location ?? "";
  const statusFilter = searchParams?.status ?? "";

  const [{ locations, error: locationsError }, submissionsResult, pendingSubmissionsResult] = await Promise.all([
    loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess),
    loadCodSubmissions(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess, {
      formType: selectedClient,
      fromDate,
      locationId: locationFilter,
      toDate,
      validationStatus: ""
    }),
    // Unscoped by date so Pending COD does not false-positive when filters are narrow
    loadCodSubmissions(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess, {
      formType: selectedClient === "flipkart" ? "flipkart" : selectedClient === "amazon" ? "amazon" : "",
      locationId: locationFilter,
      validationStatus: ""
    })
  ]);

  const clientLocations = selectedClient
    ? locations.filter((location) => inferFormTypeFromLocation(location) === selectedClient)
    : locations;
  const scopedLocationIds = (locationFilter
    ? clientLocations.filter((location) => location.id === locationFilter)
    : clientLocations
  ).map((location) => location.id);
  // Single-day snapshot used by "Station reconciliation status" below — anchors on the
  // To date filter when set, otherwise yesterday (the latest day that should be fully closed).
  const focusDate = toDate || yesterday;

  const [closuresResult, cashActivityResult] = await Promise.all([
    selectedClient === "flipkart"
      ? Promise.resolve({ rows: [] as CodDayClosure[], error: null as string | null })
      // finalOnly: false — station-day register needs to show in-progress stations too,
      // not just ones that reached final submit (see codClosureStageLabel below).
      : loadFinalCodDayClosures(companyId, scopedLocationIds, {
          fromDate,
          toDate: toDate || undefined,
          locationId: locationFilter || undefined,
          finalOnly: false
        }),
    loadCodCashActivity(companyId, scopedLocationIds, focusDate)
  ]);

  const setupError = submissionsResult.error && isMissingCodSetup({ message: submissionsResult.error })
    ? submissionsResult.error
    : null;
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const finalClosureRows = closuresResult.rows.filter((closure) => closure.is_final_submitted);

  const pendingClosures = finalClosureRows.filter((closure) => {
    if (closure.business_date > yesterday) return false;
    if (fromDate && closure.business_date < fromDate) return false;
    if (toDate && closure.business_date > toDate) return false;
    const hasSubmission = pendingSubmissionsResult.rows.some((submission) => submissionMatchesClosure(submission, closure));
    return !hasSubmission;
  });

  const stationDayRows = buildStationDayRows(
    closuresResult.rows,
    submissionsResult.rows,
    locationById,
    statusFilter
  );

  // Every permitted station's reconciliation status for the focus date — surfaces stations
  // that never opened the cash sheet, or opened it but never pushed it through submit,
  // which loadFinalCodDayClosures alone would render completely invisible.
  const closureByLocationForFocus = new Map(
    closuresResult.rows.filter((closure) => closure.business_date === focusDate).map((closure) => [closure.location_id, closure])
  );
  const activityByLocation = new Map(cashActivityResult.rows.map((row) => [row.locationId, row]));
  const focusLocations = locationFilter ? clientLocations.filter((location) => location.id === locationFilter) : clientLocations;
  const stationFocusRows = focusLocations.map((location) => {
    const closure = closureByLocationForFocus.get(location.id) ?? null;
    const activity = activityByLocation.get(location.id) ?? null;
    return buildStationFocusRow(location, closure, activity, focusDate);
  }).sort((a, b) => statusUrgency(a.status) - statusUrgency(b.status) || a.stationLabel.localeCompare(b.stationLabel));
  const notStartedCount = stationFocusRows.filter((row) => row.status === "Missing — cash sheet not started").length;

  const deposited = submissionsResult.rows.reduce((sum, row) => sum + amountValue(row.deposited_amount), 0);
  const verified = submissionsResult.rows.filter((row) => row.validation_status === "Matched").length;
  const issues = submissionsResult.rows.filter((row) => ["Short", "Excess", "Rejected"].includes(row.validation_status)).length;
  const erCollectedTotal = finalClosureRows.reduce((sum, row) => sum + amountValue(row.collected_cod), 0);
  const varianceTotal = deposited - erCollectedTotal;

  return (
    <>
      <PageHead
        eyebrow="Ops Pulse"
        title="COD Reports"
        subtitle="Pending COD after Executive Reconciliation, plus station-day deposit analysis with slip proof."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />
      <CodSectionTabs active="reports" />
{setupError ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Database setup needed</strong><p className="subtle" style={{ marginTop: 6 }}>{codSetupMessage(setupError)}</p></div>
        </section>
      ) : null}

      {!setupError && (locationsError || submissionsResult.error || closuresResult.error) ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load COD reports</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{locationsError ?? submissionsResult.error ?? closuresResult.error}</p>
          </div>
        </section>
      ) : null}

      {!setupError ? (
        <>
          <section className="panel">
            <div className="panel-body">
              <form action="/ops-pulse/cod/reports" className="form-grid five report-filter-grid">
                <label>From<input className="field" name="from" type="date" defaultValue={fromDate} /></label>
                <label>To<input className="field" name="to" type="date" defaultValue={toDate} /></label>
                <label>Station
                  <select className="field" name="location" defaultValue={locationFilter}>
                    <option value="">All permitted stations</option>
                    {clientLocations.map((location) => <option key={location.id} value={location.id}>{locationLabel(location)}</option>)}
                  </select>
                </label>
                <label>Client
                  <select className="field" name="client" defaultValue={selectedClient}>
                    <option value="">All clients</option>
                    <option value="amazon">Amazon</option>
                    <option value="flipkart">Flipkart</option>
                  </select>
                </label>
                <label>Status
                  <select className="field" name="status" defaultValue={statusFilter}>
                    <option value="">All statuses</option>
                    <option value="in_progress">In progress (not finalized)</option>
                    <option value="Pending">Pending submission</option>
                    <option value="Submitted">Submitted</option>
                    <option value="Matched">Verified</option>
                    <option value="Short">Short</option>
                    <option value="Excess">Excess</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                </label>
                <div className="form-actions span-5 align-right">
                  <button className="button secondary" type="submit">Show report</button>
                </div>
              </form>
            </div>
          </section>

          {selectedClient !== "flipkart" ? (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Station reconciliation status — {formatDate(focusDate)}</h2>
                  <p className="subtle">
                    Every permitted station for this date, including ones that haven&apos;t reached Final Submit yet — those never
                    appear in the tables below, which only include closed days. Use the To date filter above to check a different day.
                  </p>
                </div>
                <span className="count-badge">{notStartedCount} not started · {stationFocusRows.length} stations</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Status</th>
                      <th>Cash entered</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stationFocusRows.length ? stationFocusRows.map((row) => (
                      <tr key={row.key}>
                        <td><strong>{row.stationLabel}</strong></td>
                        <td><StatusPill status={row.status} /></td>
                        <td>{row.collected == null ? "-" : `${formatAmount(row.collected)}${row.entryCount ? ` · ${row.entryCount} associate${row.entryCount === 1 ? "" : "s"}` : ""}`}</td>
                        <td>{row.actionHref ? <Link href={row.actionHref} prefetch={false}>Open reconciliation</Link> : <span className="subtle">Closed</span>}</td>
                      </tr>
                    )) : (
                      <tr><td className="empty-cell" colSpan={4}>No stations in scope for this filter.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {selectedClient !== "flipkart" ? (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Pending COD</h2>
                  <p className="subtle">
                    Executive Reconciliation final-submitted through {formatDate(yesterday)}, but COD Submission not completed yet.
                  </p>
                </div>
                <span className="count-badge">{pendingClosures.length} pending</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Business Date</th>
                      <th>Station</th>
                      <th>Collected COD</th>
                      <th>Remittance expected</th>
                      <th>Days pending</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingClosures.length ? pendingClosures.map((closure) => {
                      const location = locationById.get(closure.location_id);
                      const href = `/ops-pulse/cod/submission?client=amazon&location=${encodeURIComponent(closure.location_id)}&deposit_date=${encodeURIComponent(closure.business_date)}`;
                      return (
                        <tr key={closure.id}>
                          <td>{formatDate(closure.business_date)}</td>
                          <td><strong>{locationLabel(location) || closure.station_code}</strong></td>
                          <td>{formatAmount(closure.collected_cod)}</td>
                          <td>{formatAmount(remittanceExpectedFromClosure(closure))}</td>
                          <td>{daysBetweenYmd(closure.business_date, yesterday)}</td>
                          <td><Link href={href} prefetch={false}>Submit COD</Link></td>
                        </tr>
                      );
                    }) : (
                      <tr><td className="empty-cell" colSpan={6}>No pending COD — all closed days through yesterday have a submission.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="summary-grid">
            <div className="metric-card"><span>Pending COD</span><strong>{pendingClosures.length}</strong><small>ER done, slip missing</small></div>
            <div className="metric-card"><span>ER closed days</span><strong>{finalClosureRows.length}</strong><small>Final submitted</small></div>
            <div className="metric-card"><span>Submissions</span><strong>{submissionsResult.rows.length}</strong><small>Deposit slips filed</small></div>
            <div className="metric-card"><span>Deposited</span><strong>{formatAmount(deposited)}</strong><small>Station submitted value</small></div>
            <div className="metric-card"><span>Verified</span><strong>{verified}</strong><small>Matched / portal verified</small></div>
            <div className="metric-card"><span>Issues</span><strong>{issues}</strong><small>Short / Excess / Rejected</small></div>
            <div className="metric-card"><span>ER vs deposited</span><strong>{formatAmount(varianceTotal)}</strong><small>Deposited − ER collected</small></div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Station-day register</h2>
                <p className="subtle">Executive Reconciliation cash joined with COD Submission deposit proof. Includes in-progress days — check Status for the pipeline stage.</p>
              </div>
              <span className="count-badge">{stationDayRows.length} rows</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Station</th>
                    <th>Client</th>
                    <th>ER Collected</th>
                    <th>ER Remittance</th>
                    <th>Submitted</th>
                    <th>Remittance Code</th>
                    <th>Slip</th>
                    <th>Status</th>
                    <th>Variance</th>
                    <th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {stationDayRows.length ? stationDayRows.map((row) => (
                    <tr key={row.key}>
                      <td>{formatDate(row.date)}</td>
                      <td><strong>{row.stationLabel}</strong></td>
                      <td>{row.client}</td>
                      <td>{row.erCollected == null ? "-" : formatAmount(row.erCollected)}</td>
                      <td>{row.erRemittance == null ? "-" : formatAmount(row.erRemittance)}</td>
                      <td>{row.submittedAmount == null ? "-" : formatAmount(row.submittedAmount)}</td>
                      <td>{row.remittanceCode}</td>
                      <td>
                        {row.slipUrl ? (
                          <a href={row.slipUrl} rel="noreferrer" target="_blank">View</a>
                        ) : (
                          <span className="subtle">—</span>
                        )}
                      </td>
                      <td><StatusPill status={row.status} /></td>
                      <td>{row.variance == null ? "-" : formatAmount(row.variance)}</td>
                      <td>{row.remarks}</td>
                    </tr>
                  )) : (
                    <tr><td className="empty-cell" colSpan={11}>No station-day rows for this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Submission detail</h2>
                <p className="subtle">Individual deposit slips in the selected range.</p>
              </div>
              <span className="count-badge">{submissionsResult.rows.length} slips</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Submitted</th>
                    <th>Station</th>
                    <th>COD Period</th>
                    <th>Deposit Date</th>
                    <th>Remittance</th>
                    <th>Amount</th>
                    <th>Slip</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {submissionsResult.rows.length ? submissionsResult.rows.map((row) => {
                    const station = firstRelation(row.stations);
                    const slips = depositAttachmentsFor(row);
                    return (
                      <tr key={row.id}>
                        <td>{formatDateTime(row.created_at)}</td>
                        <td><strong>{locationLabel(station) || row.station_code || "-"}</strong></td>
                        <td>{codPeriod(row)}</td>
                        <td>{formatDate(row.deposit_date)}</td>
                        <td>{row.remittance_code ?? row.reference_no ?? "-"}</td>
                        <td>{formatAmount(row.deposited_amount)}</td>
                        <td>
                          {slips.length ? (
                            <a href={depositSlipViewUrl(row.id)} rel="noreferrer" target="_blank">View</a>
                          ) : (
                            <span className="subtle">Missing</span>
                          )}
                        </td>
                        <td><StatusPill status={row.validation_status} /></td>
                      </tr>
                    );
                  }) : (
                    <tr><td className="empty-cell" colSpan={8}>No submissions in this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

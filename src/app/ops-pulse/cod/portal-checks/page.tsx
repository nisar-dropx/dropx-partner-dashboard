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
  formatAmount,
  formatDate,
  formatDateTime,
  isMissingCodSetup,
  loadCodLocations,
  loadPortalCheckRuns,
  locationLabel,
  portalCheckLabel
} from "@/lib/ops-pulse/cod";
import { isSupabaseAdminConfigured } from "@/lib/supabase-admin";
import { queuePortalChecks } from "./actions";

type SearchParams = {
  check_date?: string;
  location?: string;
  status?: string;
  type?: string;
};

function todayKolkata() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).format(new Date());
}

function loadFlash() {
  const raw = cookies().get("dropx_cod_portal_checks_flash")?.value;
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

function workerLinks() {
  const raw = process.env.OPS_PORTAL_WORKER_URL?.trim();
  if (!raw) {
    return {
      base: null as string | null,
      browser: null as string | null,
      configured: false,
      health: null as string | null,
      message: "OPS_PORTAL_WORKER_URL is not configured in Vercel."
    };
  }

  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/(run|warmup)\/?$/, "").replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    const base = url.toString().replace(/\/$/, "");
    return {
      base,
      browser: `${base}/vnc.html`,
      configured: true,
      health: `${base}/health`,
      message: null as string | null
    };
  } catch {
    return {
      base: null,
      browser: null,
      configured: false,
      health: null,
      message: "OPS_PORTAL_WORKER_URL is invalid."
    };
  }
}

function portalRunStatusLabel(status: string, checkType: string) {
  if (status === "Fail" && checkType === "driver_reconciliation") return "Pending recon found";
  if (status === "Pass" && checkType === "driver_reconciliation") return "Driver recon cleared";
  if (status === "Error") return "Validation unavailable";
  if (status === "Manual Review") return "Manual login required";
  return status;
}

export const dynamic = "force-dynamic";

export default async function PortalChecksPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cod_portal_checks", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.cod_portal_checks;
  const flash = loadFlash();
  const checkDate = searchParams?.check_date || todayKolkata();
  const [{ locations, error: locationsError }, runsResult] = await Promise.all([
    loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess),
    loadPortalCheckRuns(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess, {
      checkDate,
      locationId: searchParams?.location ?? "",
      status: searchParams?.status ?? "",
      checkType: searchParams?.type ?? ""
    })
  ]);
  const setupError = runsResult.error && isMissingCodSetup({ message: runsResult.error }) ? runsResult.error : null;
  const rows = runsResult.rows;
  const passed = rows.filter((row) => row.status === "Pass").length;
  const failed = rows.filter((row) => ["Fail", "Error", "Manual Review"].includes(row.status)).length;
  const queued = rows.filter((row) => ["Queued", "Running"].includes(row.status)).length;
  const pendingAmount = rows.reduce((sum, row) => sum + amountValue(row.pending_amount), 0);
  const manualReview = rows.filter((row) => row.status === "Manual Review").length;
  const workerErrors = rows.filter((row) => row.status === "Error").length;
  const worker = workerLinks();

  return (
    <>
      <PageHead
        eyebrow="Ops Pulse"
        title="COD Portal Checks"
        subtitle="Queue and monitor backend checks for Amazon driver reconciliation and prepared deposit status."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />
      <CodSectionTabs active="portal-checks" />

      {setupError ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Database setup needed</strong><p className="subtle" style={{ marginTop: 6 }}>{codSetupMessage(setupError)}</p></div>
        </section>
      ) : null}

      {!setupError && (runsResult.error || locationsError) ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Unable to load portal checks</strong><p className="subtle" style={{ marginTop: 6 }}>{runsResult.error ?? locationsError}</p></div>
        </section>
      ) : null}

      {!setupError && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body"><strong>{flash.error ? "Action required" : "Completed"}</strong><p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p></div>
        </section>
      ) : null}

      {!setupError ? (
        <>
          <section className="panel">
            <div className="panel-head toolbar">
              <div>
                <h2>Control tower worker</h2>
                <p className="subtle">Monitor the Amazon backend browser session and open it only when Amazon asks for MFA/manual approval.</p>
              </div>
              <StatusPill status={worker.configured ? "Ready" : "Not configured"} />
            </div>
            <div className="panel-body">
              <section className="summary-grid">
                <div className="metric-card"><span>Worker config</span><strong>{worker.configured ? "Ready" : "Missing"}</strong><small>{worker.base ?? "Set worker URL in Vercel"}</small></div>
                <div className="metric-card"><span>Manual login needed</span><strong>{manualReview}</strong><small>MFA/captcha or Amazon approval</small></div>
                <div className="metric-card"><span>Worker errors</span><strong>{workerErrors}</strong><small>Needs control tower review</small></div>
                <div className="metric-card"><span>Biometric middleware</span><strong>Separate</strong><small>This does not touch bio.dropxlogistics.com</small></div>
              </section>
              {worker.configured && worker.health && worker.browser ? (
                <div className="form-actions">
                  <a className="button secondary" href={worker.health} target="_blank" rel="noreferrer">Health check</a>
                  <a className="button" href={worker.browser} target="_blank" rel="noreferrer">Open worker browser</a>
                  <a className="button secondary" href="/settings/amazon">Amazon credentials</a>
                </div>
              ) : (
                <div className="alert danger"><strong>Worker link missing</strong><span>{worker.message}</span></div>
              )}
              <p className="field-hint">Control tower can relogin inside the worker browser. The dashboard queues/checks SCC work; the worker browser keeps Amazon session separately from your laptop Chrome.</p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head toolbar">
              <div>
                <h2>Run checks</h2>
                <p className="subtle">Use this for the real office test: select the date/station, queue checks, then let the backend worker update the result.</p>
              </div>
            </div>
            <div className="panel-body">
              <form action="/ops-pulse/cod/portal-checks" className="form-grid three">
                <label>Check date<input className="field" name="check_date" type="date" defaultValue={checkDate} /></label>
                <label>Station
                  <select className="field" name="location" defaultValue={searchParams?.location ?? ""}>
                    <option value="">All permitted stations</option>
                    {locations.map((location) => <option key={location.id} value={location.id}>{locationLabel(location)}</option>)}
                  </select>
                </label>
                <label>Status
                  <select className="field" name="status" defaultValue={searchParams?.status ?? ""}>
                    <option value="">All statuses</option>
                    <option value="Queued">Queued</option>
                    <option value="Running">Running</option>
                    <option value="Pass">Cleared</option>
                    <option value="Fail">Pending recon found</option>
                    <option value="Manual Review">Manual login required</option>
                    <option value="Error">Validation unavailable</option>
                    <option value="Skipped">Skipped</option>
                  </select>
                </label>
                <label>Check type
                  <select className="field" name="type" defaultValue={searchParams?.type ?? ""}>
                    <option value="">Both checks</option>
                    <option value="driver_reconciliation">Driver Reconciliation</option>
                    <option value="prepared_deposit">Prepared Deposit</option>
                  </select>
                </label>
                <div className="form-actions span-2 align-right">
                  <button className="button secondary" type="submit">Show status</button>
                </div>
              </form>
              <form action={queuePortalChecks} className="form-actions align-right" style={{ marginTop: 16 }}>
                <input name="check_date" type="hidden" value={checkDate} />
                <input name="location_id" type="hidden" value={searchParams?.location ?? ""} />
                <SubmitButton disabled={!permission.canAdd || !isSupabaseAdminConfigured}>Queue checks</SubmitButton>
              </form>
            </div>
          </section>

          <section className="summary-grid">
            <div className="metric-card"><span>Queued / running</span><strong>{queued}</strong><small>{formatDate(checkDate)}</small></div>
            <div className="metric-card"><span>Passed</span><strong>{passed}</strong><small>Completed with no pending liability</small></div>
            <div className="metric-card"><span>Needs action</span><strong>{failed}</strong><small>Pending recon or validation issue</small></div>
            <div className="metric-card"><span>Pending amount</span><strong>{formatAmount(pendingAmount)}</strong><small>Reported by portal worker</small></div>
          </section>

          <section className="panel">
            <div className="panel-head toolbar">
              <div>
                <h2>Check runs</h2>
                <p className="subtle">Every row is a real check request/result. Empty means no check has been queued or received for the filter.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Station</th>
                    <th>Portal Station</th>
                    <th>Check</th>
                    <th>Status</th>
                    <th>Pending Count</th>
                    <th>Pending Amount</th>
                    <th>Attempts</th>
                    <th>Last Checked</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? rows.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDate(row.check_date)}</td>
                      <td><strong>{locationLabel(Array.isArray(row.stations) ? row.stations[0] : row.stations) || row.station_code}</strong></td>
                      <td>{row.portal_station_code ?? "-"}</td>
                      <td>{portalCheckLabel(row.check_type)}</td>
                      <td><StatusPill status={portalRunStatusLabel(row.status, row.check_type)} /></td>
                      <td>{row.pending_count}</td>
                      <td>{formatAmount(row.pending_amount)}</td>
                      <td>{row.attempt_count}</td>
                      <td>{formatDateTime(row.last_checked_at)}</td>
                      <td>{row.error_message ?? row.summary ?? "-"}</td>
                    </tr>
                  )) : (
                    <tr><td className="empty-cell" colSpan={10}>No portal checks queued or received for this filter.</td></tr>
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

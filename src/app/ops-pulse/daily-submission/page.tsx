
import { ReportTable } from "@/components/report-table";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SearchableSelect } from "@/components/searchable-select";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  codSetupMessage,
  dailySubmissionAttachmentFields,
  dailySubmissionChecklistFields,
  firstRelation,
  formatDate,
  formatDateTime,
  inferFormTypeFromLocation,
  isMissingCodSetup,
  loadCodLocations,
  loadDailySubmissions,
  locationLabel,
  type OpsDailySubmissionRow
} from "@/lib/ops-pulse/cod";
import { isSupabaseAdminConfigured } from "@/lib/supabase-admin";
import { createDailySubmission } from "./actions";

type SearchParams = {
  ai_status?: string;
  business_date?: string;
  client?: string;
  location?: string;
  manager_status?: string;
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
  const raw = cookies().get("dropx_daily_submission_flash")?.value;
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

function attachmentCount(row: OpsDailySubmissionRow) {
  return Array.isArray(row.attachments) ? row.attachments.length : 0;
}

function checklistText(row: OpsDailySubmissionRow) {
  const payload = row.checklist_payload ?? {};
  const values = dailySubmissionChecklistFields
    .map((item) => payload[item.key])
    .filter((value) => typeof value === "string" && value);
  return values.length ? values.join(" / ") : "-";
}

export const dynamic = "force-dynamic";

export default async function DailySubmissionPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("daily_submission", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.daily_submission;
  const flash = loadFlash();
  const businessDate = searchParams?.business_date || todayKolkata();
  const [{ locations, error: locationsError }, submissionsResult] = await Promise.all([
    loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess),
    loadDailySubmissions(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess, {
      aiStatus: searchParams?.ai_status ?? "",
      businessDate,
      locationId: searchParams?.location ?? "",
      managerStatus: searchParams?.manager_status ?? ""
    })
  ]);
  const setupError = submissionsResult.error && isMissingCodSetup({ message: submissionsResult.error }) ? submissionsResult.error : null;
  const selectedClient = searchParams?.client === "amazon" || searchParams?.client === "flipkart" ? searchParams.client : "";
  const clientLocations = selectedClient ? locations.filter((location) => inferFormTypeFromLocation(location) === selectedClient) : locations;
  const clientLocationIds = new Set(clientLocations.map((location) => location.id));
  const stationOptions = clientLocations.map((location) => ({
    value: location.id,
    label: locationLabel(location),
    helper: [location.state, location.station_manager_email].filter(Boolean).join(" / ")
  }));
  const rows = selectedClient
    ? submissionsResult.rows.filter((row) => !row.location_id || clientLocationIds.has(row.location_id))
    : submissionsResult.rows;
  const submittedStations = new Set(rows.map((row) => row.location_id).filter(Boolean)).size;
  const pendingManager = rows.filter((row) => row.manager_status === "Pending").length;
  const queuedAi = rows.filter((row) => String(row.ai_status ?? "").toLowerCase().includes("queued")).length;
  const proofCount = rows.reduce((sum, row) => sum + attachmentCount(row), 0);

  return (
    <AppShell active="Ops Pulse" pageCode="daily_submission">
      <PageHead
        eyebrow="Ops Pulse"
        title="Daily Submission"
        subtitle="Station EOD checklist and proof upload for driver reconciliation, prepared deposit, remittance, and closure checks."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {setupError ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Database setup needed</strong><p className="subtle" style={{ marginTop: 6 }}>{codSetupMessage(setupError)}</p></div>
        </section>
      ) : null}

      {!setupError && (locationsError || submissionsResult.error) ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Unable to load daily submissions</strong><p className="subtle" style={{ marginTop: 6 }}>{locationsError ?? submissionsResult.error}</p></div>
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
                <h2>Submit station EOD</h2>
                <p className="subtle">One window for the station team to upload daily proof before closure. AI validation reads these files and marks the result for manager review.</p>
              </div>
            </div>
            <div className="panel-body">
              <form action={createDailySubmission} className="form-grid three" encType="multipart/form-data">
                <label>Business Date<input className="field" name="business_date" type="date" defaultValue={businessDate} required /></label>
                <label className="span-2">Station
                  <SearchableSelect
                    disabled={!permission.canAdd}
                    name="location_id"
                    options={stationOptions}
                    placeholder="Select station"
                    required
                    defaultValue={searchParams?.location ?? ""}
                  />
                </label>
                <label>Submitted By<input className="field" name="submitter_name" placeholder="Name of station user" /></label>
                <label className="span-2">Remittance Codes
                  <textarea className="field" name="remittance_codes" placeholder="Enter remittance code(s), one per line if multiple" rows={3} />
                </label>
                <div className="span-3 section-divider">
                  <strong>Checklist</strong>
                  <span>These values guide manager and AI validation. The final decision still remains visible to managers.</span>
                </div>
                {dailySubmissionChecklistFields.map((item) => (
                  <label key={item.key}>{item.label}
                    <select className="field" name={item.key} defaultValue="">
                      <option value="">Select status</option>
                      {item.options.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  </label>
                ))}
                <div className="span-3 section-divider">
                  <strong>Proof Uploads</strong>
                  <span>Upload only the actual screenshots required for EOD review. Bank/CMS deposit slip belongs in COD Submission.</span>
                </div>
                {dailySubmissionAttachmentFields.map(([field, label]) => (
                  <label key={field}>{label}<input className="field" name={field} type="file" accept="image/*,.pdf" /></label>
                ))}
                <div className="form-actions span-3 align-right">
                  <SubmitButton disabled={!permission.canAdd || !isSupabaseAdminConfigured}>Submit EOD</SubmitButton>
                </div>
              </form>
            </div>
          </section>

          <section className="panel">
            <div className="panel-body">
              <form action="/ops-pulse/daily-submission" className="form-grid four">
                <label>Date<input className="field" name="business_date" type="date" defaultValue={businessDate} /></label>
                <label>Station
                  <select className="field" name="location" defaultValue={searchParams?.location ?? ""}>
                    <option value="">All permitted stations</option>
                    {clientLocations.map((location) => <option key={location.id} value={location.id}>{locationLabel(location)}</option>)}
                  </select>
                </label>
                <input type="hidden" name="client" value={selectedClient} />
                <label>Manager Status
                  <select className="field" name="manager_status" defaultValue={searchParams?.manager_status ?? ""}>
                    <option value="">All statuses</option>
                    {["Pending", "Accepted", "Exception", "Rejected"].map((status) => <option key={status}>{status}</option>)}
                  </select>
                </label>
                <label>AI Status
                  <select className="field" name="ai_status" defaultValue={searchParams?.ai_status ?? ""}>
                    <option value="">All AI statuses</option>
                    {["Queued", "Passed", "Manual Review", "Rejected", "Awaiting proof"].map((status) => <option key={status}>{status}</option>)}
                  </select>
                </label>
                <div className="form-actions span-4 align-right">
                  <button className="button secondary" type="submit">Show submissions</button>
                </div>
              </form>
            </div>
          </section>

          <section className="summary-grid">
            <div className="metric-card"><span>Submissions</span><strong>{rows.length}</strong><small>{formatDate(businessDate)}</small></div>
            <div className="metric-card"><span>Stations submitted</span><strong>{submittedStations}</strong><small>Within your access</small></div>
            <div className="metric-card"><span>Manager pending</span><strong>{pendingManager}</strong><small>Awaiting review</small></div>
            <div className="metric-card"><span>Proof files</span><strong>{proofCount}</strong><small>{queuedAi} queued for AI</small></div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Daily submission register</h2>
                <p className="subtle">Real submissions only. Empty means the station has not submitted for the selected filter.</p>
              </div>
              <span className="count-badge">{rows.length} records</span>
            </div>
            <div className="table-wrap">
              <ReportTable>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Station</th>
                    <th>Submitted By</th>
                    <th>Remittance Codes</th>
                    <th>Proofs</th>
                    <th>Checklist</th>
                    <th>Manager</th>
                    <th>AI</th>
                    <th>Submitted At</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? rows.map((row) => {
                    const station = firstRelation(row.stations);
                    return (
                      <tr key={row.id}>
                        <td>{formatDate(row.business_date)}</td>
                        <td><strong>{locationLabel(station) || row.station_code || "-"}</strong></td>
                        <td>{row.submitter_name ?? "-"}</td>
                        <td>{row.remittance_codes?.length ? row.remittance_codes.join(", ") : "-"}</td>
                        <td>{attachmentCount(row)}</td>
                        <td>{checklistText(row)}</td>
                        <td><StatusPill status={row.manager_status} /></td>
                        <td><StatusPill status={row.ai_status ?? "Not queued"} /></td>
                        <td>{formatDateTime(row.created_at)}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td className="empty-cell" colSpan={9}>No daily submissions found for this filter.</td></tr>
                  )}
                </tbody>
              </ReportTable>
            </div>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}

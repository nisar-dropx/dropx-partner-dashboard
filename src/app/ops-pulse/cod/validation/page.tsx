import { cookies } from "next/headers";
import { CodSectionTabs } from "@/components/cod-section-tabs";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  codPeriod,
  codSetupMessage,
  codValidationStatuses,
  depositAttachmentsFor,
  firstRelation,
  formatAmount,
  formatDate,
  formatDateTime,
  inferFormTypeFromLocation,
  isMissingCodSetup,
  loadCodLocations,
  loadCodSubmissions,
  locationLabel,
  submittedCodAmount
} from "@/lib/ops-pulse/cod";
import { isSupabaseAdminConfigured } from "@/lib/supabase-admin";
import { validateCodSubmission } from "./actions";

type SearchParams = {
  client?: string;
  from?: string;
  location?: string;
  status?: string;
  to?: string;
};

function loadFlash() {
  const raw = cookies().get("dropx_cod_validation_flash")?.value;
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

export const dynamic = "force-dynamic";

export default async function CodValidationPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cod_validation", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.cod_validation;
  const flash = loadFlash();
  const selectedClient = searchParams?.client === "amazon" || searchParams?.client === "flipkart" ? searchParams.client : "";
  const [{ locations, error: locationsError }, submissionsResult] = await Promise.all([
    loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess),
    loadCodSubmissions(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess, {
      fromDate: searchParams?.from ?? "",
      formType: selectedClient,
      locationId: searchParams?.location ?? "",
      toDate: searchParams?.to ?? "",
      validationStatus: searchParams?.status ?? "Pending"
    })
  ]);
  const clientLocations = selectedClient ? locations.filter((location) => inferFormTypeFromLocation(location) === selectedClient) : locations;
  const setupError = submissionsResult.error && isMissingCodSetup({ message: submissionsResult.error }) ? submissionsResult.error : null;

  return (
    <>
      <PageHead
        eyebrow="Ops Pulse"
        title="COD Validation"
        subtitle="Manager validation queue for COD deposits submitted by stations."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />
      <CodSectionTabs active="validation" />

      {setupError ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Database setup needed</strong><p className="subtle" style={{ marginTop: 6 }}>{codSetupMessage(setupError)}</p></div>
        </section>
      ) : null}

      {!setupError && (locationsError || submissionsResult.error) ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Unable to load validation queue</strong><p className="subtle" style={{ marginTop: 6 }}>{locationsError ?? submissionsResult.error}</p></div>
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
            <div className="panel-body">
              <form action="/ops-pulse/cod/validation" className="form-grid four">
                <label>From<input className="field" name="from" type="date" defaultValue={searchParams?.from ?? ""} /></label>
                <label>To<input className="field" name="to" type="date" defaultValue={searchParams?.to ?? ""} /></label>
                <label>Station
                  <select className="field" name="location" defaultValue={searchParams?.location ?? ""}>
                    <option value="">All permitted stations</option>
                    {clientLocations.map((location) => <option key={location.id} value={location.id}>{locationLabel(location)}</option>)}
                  </select>
                </label>
                <input type="hidden" name="client" value={selectedClient} />
                <label>Status
                  <select className="field" name="status" defaultValue={searchParams?.status ?? "Pending"}>
                    <option value="">All statuses</option>
                    {codValidationStatuses.map((status) => <option key={status}>{status}</option>)}
                  </select>
                </label>
                <div className="form-actions span-4 align-right">
                  <button className="button secondary" type="submit">Show queue</button>
                </div>
              </form>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Validation queue</h2>
                <p className="subtle">Validate the proof against remittance and CMS/bank deposit details.</p>
              </div>
              <span className="count-badge">{submissionsResult.rows.length} records</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Station</th>
                    <th>COD Date</th>
                    <th>Deposit Date</th>
                    <th>Remittance</th>
                    <th>Submitted Amount</th>
                    <th>Proofs</th>
                    <th>AI Result</th>
                    <th>Validate</th>
                  </tr>
                </thead>
                <tbody>
                  {submissionsResult.rows.length ? submissionsResult.rows.map((row) => {
                    const station = firstRelation(row.stations);
                    const amount = submittedCodAmount(row);
                    return (
                      <tr key={row.id}>
                        <td><strong>{locationLabel(station) || row.station_code || "-"}</strong><div className="subtle">{formatDateTime(row.created_at)}</div></td>
                        <td>{codPeriod(row)}</td>
                        <td>{formatDate(row.deposit_date)}</td>
                        <td>{row.remittance_code ?? row.reference_no ?? "-"}</td>
                        <td>{formatAmount(amount)}</td>
                        <td>{depositAttachmentsFor(row).length}</td>
                        <td><StatusPill status={row.ai_status ?? "Manual Review"} /><div className="subtle">{row.ai_summary ?? "-"}</div></td>
                        <td>
                          <form action={validateCodSubmission} className="inline-validation-form">
                            <input name="id" type="hidden" value={row.id} />
                            <select className="field compact-field" name="validation_status" defaultValue={row.validation_status}>
                              {codValidationStatuses.map((status) => <option key={status}>{status}</option>)}
                            </select>
                            <input className="field compact-field" name="validated_amount" defaultValue={amount.toFixed(2)} inputMode="decimal" />
                            <input className="field compact-field" name="validation_remarks" placeholder="Remarks" />
                            <SubmitButton className="button compact" disabled={!permission.canEdit || !isSupabaseAdminConfigured}>Save</SubmitButton>
                          </form>
                        </td>
                      </tr>
                    );
                  }) : (
                    <tr><td className="empty-cell" colSpan={8}>No COD submissions found for this filter.</td></tr>
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

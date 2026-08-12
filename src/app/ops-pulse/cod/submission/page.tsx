import { cookies } from "next/headers";
import { CodSectionTabs } from "@/components/cod-section-tabs";
import { PageHead } from "@/components/page-head";
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
  inferFormTypeFromLocation,
  isMissingCodSetup,
  loadCodLocations,
  loadCodSubmissions,
  locationLabel,
  formTypeLabel
} from "@/lib/ops-pulse/cod";
import { isSupabaseAdminConfigured } from "@/lib/supabase-admin";
import { CodSubmissionForm } from "./cod-submission-form";
import { CodSubmissionRegister, type CodRegisterRow } from "./cod-submission-register";

type SearchParams = {
  client?: string;
  from?: string;
  location?: string;
  status?: string;
  to?: string;
  deposit_date?: string;
  flash_error?: string;
  flash_notice?: string;
};

function todayKolkata() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).format(new Date());
}

function loadFlash(searchParams?: SearchParams) {
  // URL flash is reliable after server-action redirects (cookie clear during RSC can crash).
  const fromUrlError = typeof searchParams?.flash_error === "string" ? searchParams.flash_error.trim() : "";
  const fromUrlNotice = typeof searchParams?.flash_notice === "string" ? searchParams.flash_notice.trim() : "";
  if (fromUrlError || fromUrlNotice) {
    return {
      error: fromUrlError || null,
      notice: fromUrlNotice || null
    };
  }

  const raw = cookies().get("dropx_cod_submission_flash")?.value;
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
export const maxDuration = 120;

export default async function CodSubmissionPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("cod_submission", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.cod_submission;
  const flash = loadFlash(searchParams);
  const today = todayKolkata();
  const selectedClient = searchParams?.client === "amazon" || searchParams?.client === "flipkart" ? searchParams.client : "";
  const [{ locations, error: locationsError }, submissionsResult] = await Promise.all([
    loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess),
    loadCodSubmissions(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess, {
      fromDate: searchParams?.from ?? "",
      formType: selectedClient,
      locationId: searchParams?.location ?? "",
      toDate: searchParams?.to ?? "",
      validationStatus: searchParams?.status ?? ""
    })
  ]);
  const setupError = submissionsResult.error && isMissingCodSetup({ message: submissionsResult.error }) ? submissionsResult.error : null;
  const clientLocations = selectedClient ? locations.filter((location) => inferFormTypeFromLocation(location) === selectedClient) : locations;
  const stationOptions = clientLocations.map((location) => {
    const inferred = inferFormTypeFromLocation(location);
    return {
      value: location.id,
      label: locationLabel(location),
      helper: [location.state, inferred ? formTypeLabel(inferred) : "Client from Location Master"].filter(Boolean).join(" / "),
      stationCode: String(location.station_code ?? "").trim().toUpperCase(),
      formType: inferred || ""
    };
  });
  const defaultLocationId = searchParams?.location && stationOptions.some((o) => o.value === searchParams.location)
    ? searchParams.location
    : undefined;
  const defaultDepositDate = searchParams?.deposit_date && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.deposit_date)
    ? searchParams.deposit_date
    : today;

  const registerRows: CodRegisterRow[] = submissionsResult.rows.map((row) => {
    const station = firstRelation(row.stations);
    const slips = depositAttachmentsFor(row);
    const depositRaw = String(row.deposit_date ?? "").slice(0, 10);
    const fromRaw = String(row.cod_period_from ?? row.cod_date ?? depositRaw).slice(0, 10);
    const toRaw = String(row.cod_period_to ?? fromRaw).slice(0, 10);
    return {
      id: row.id,
      submittedAt: formatDateTime(row.created_at),
      stationLabel: locationLabel(station) || row.station_code || "-",
      client: row.client ?? formTypeLabel(row.form_type),
      formType: row.form_type || inferFormTypeFromLocation(station) || "",
      locationId: row.location_id || "",
      stationCode: String(row.station_code ?? station?.station_code ?? "").trim().toUpperCase(),
      codPeriod: codPeriod(row),
      depositDate: depositRaw,
      depositDateLabel: formatDate(depositRaw),
      codPeriodFrom: fromRaw,
      codPeriodTo: toRaw,
      remittanceCode: row.remittance_code ?? row.reference_no ?? "",
      amount: formatAmount(row.deposited_amount),
      amountRaw: String(amountValue(row.deposited_amount)),
      submitterName: row.submitter_name ?? "",
      remarks: row.remarks ?? "",
      status: row.validation_status,
      hasSlip: slips.length > 0,
      slipUrl: slips.length ? depositSlipViewUrl(row.id) : null
    };
  });

  return (
    <>
      <PageHead
        eyebrow="Ops Pulse"
        title="COD Submission"
        subtitle="Enter remittance details, verify against the portal (Amazon), and upload a photo of the deposit slip."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />
      <CodSectionTabs active="submission" />
{setupError ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Database setup needed</strong><p className="subtle" style={{ marginTop: 6 }}>{codSetupMessage(setupError)}</p></div>
        </section>
      ) : null}

      {!setupError && (locationsError || submissionsResult.error) ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Unable to load COD submissions</strong><p className="subtle" style={{ marginTop: 6 }}>{locationsError ?? submissionsResult.error}</p></div>
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
                <h2>Submit COD deposit</h2>
                <p className="subtle">Amazon submissions are checked against the portal for remittance code, deposit date, and amount before saving.</p>
              </div>
            </div>
            <div className="panel-body">
              <CodSubmissionForm
                canAdd={Boolean(permission.canAdd) && isSupabaseAdminConfigured}
                client={selectedClient}
                defaultDepositDate={defaultDepositDate}
                defaultLocationId={defaultLocationId}
                stationOptions={stationOptions}
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel-body">
              <form action="/cod/submission" className="form-grid four">
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
                  <select className="field" name="status" defaultValue={searchParams?.status ?? ""}>
                    <option value="">All statuses</option>
                    {["Pending", "Matched", "Short", "Excess", "Rejected"].map((status) => <option key={status}>{status}</option>)}
                  </select>
                </label>
                <div className="form-actions span-4 align-right">
                  <button className="button secondary" type="submit">Show submissions</button>
                </div>
              </form>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>COD submission register</h2>
                <p className="subtle">Recently added first. Preview the slip or edit a row from Actions.</p>
              </div>
              <span className="count-badge">{registerRows.length} records</span>
            </div>
            <CodSubmissionRegister
              canEdit={Boolean(permission.canEdit) && isSupabaseAdminConfigured}
              client={selectedClient}
              rows={registerRows}
              stationOptions={stationOptions}
            />
          </section>
        </>
      ) : null}
    </>
  );
}

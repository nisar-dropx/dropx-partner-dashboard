import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { decodePayoutReviewReason } from "@/lib/payout-review-display";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadDisputeFinanceAccess, disputeFinalRoleIds } from "@/lib/payout-dispute-finance-access";
import styles from "./payout-review-desk.module.css";
import { UrlPager, readPaging } from "./url-pager";
import { readAllRows } from "@/lib/supabase-pagination";
import { GuidedDisputeReview } from "./guided-dispute-review";

type Row = Record<string, any>;
type WorkflowRoleKey = "initial_approver_role_ids" | "final_approver_role_ids" | "processor_role_ids";
type WorkflowStage = "initial" | "final" | "processor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NONTERMINAL = [
  "open",
  "in_review",
  "pending_final_approval",
  "approved_for_processing",
  "processing",
  "processing_blocked"
];
const STATUS_FILTERS: Record<string, string[] | null> = {
  mine: NONTERMINAL,
  active: NONTERMINAL,
  initial: ["open"],
  final: ["in_review", "pending_final_approval"],
  processing: ["approved_for_processing", "processing", "processing_blocked"],
  resolved: ["resolved"],
  closed: ["resolved", "rejected"],
  rejected: ["rejected"],
  all: null
};
const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: "Initial review", cls: styles.warn },
  in_review: { label: "Final approval", cls: styles.info },
  pending_final_approval: { label: "Final approval", cls: styles.info },
  approved_for_processing: { label: "Ready for processing", cls: styles.ready },
  processing: { label: "Processing", cls: styles.processing },
  processing_blocked: { label: "Processing blocked", cls: styles.danger },
  resolved: { label: "Corrected", cls: styles.good },
  rejected: { label: "Rejected", cls: styles.muted }
};
const CATEGORIES: Record<string, string> = {
  counts: "Shipments / counts",
  training: "Training",
  loss: "Loss / deduction",
  tds: "TDS",
  other: "Other"
};
const CORRECTION_KINDS: Array<[string, string]> = [
  ["attendance", "Attendance"],
  ["workdays", "Work days"],
  ["production", "Production units"],
  ["payment_rate", "Payment rate"],
  ["additional_payment", "Additional payment"],
  ["deduction", "Deduction"],
  ["other", "Other"]
];

const uuid = (value?: string) => value && UUID.test(value) ? value.toLowerCase() : "";
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const roleIds = (value: unknown, key: WorkflowRoleKey) => {
  const ids = record(value)[key];
  return Array.isArray(ids) ? ids.map(String).filter((id) => UUID.test(id)).map((id) => id.toLowerCase()) : [];
};
const monthRange = (month?: string) => {
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, numericMonth] = month.split("-").map(Number);
  return {
    from: new Date(Date.UTC(year, numericMonth - 1, 1) - 5.5 * 3600000).toISOString(),
    to: new Date(Date.UTC(year, numericMonth, 1) - 5.5 * 3600000).toISOString()
  };
};
const when = (value: string | null | undefined) => value
  ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
  : "";
const moneyFromPaise = (value: unknown) => Number.isFinite(Number(value))
  ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value) / 100)
  : "—";
const netPaise = (publication: Row | undefined) => {
  const value = record(record(publication?.snapshot).item).net_amount;
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : null;
};
const period = (publication: Row | undefined) => {
  const run = record(record(publication?.snapshot).run);
  return {
    start: String(publication?.period_start || run.period_start || ""),
    end: String(publication?.period_end || run.period_end || "")
  };
};
const isNewerPublication = (candidate: Row, source: Row, dispute: Row) => {
  const candidatePeriod = period(candidate);
  const sourcePeriod = period(source);
  const processingStartedAt = new Date(dispute.processor_claimed_at || dispute.final_approved_at || 0).getTime();
  return candidate.id !== source.id
    && candidate.workforce_id === source.workforce_id
    && candidate.station_id === source.station_id
    && candidatePeriod.start === sourcePeriod.start
    && candidatePeriod.end === sourcePeriod.end
    && Number(candidate.revision || 0) > Number(source.revision || 0)
    && new Date(candidate.published_at || 0).getTime() > new Date(source.published_at || 0).getTime()
    && new Date(candidate.published_at || 0).getTime() > processingStartedAt;
};

export async function PayoutReviewDesk({
  auth,
  action,
  pageCode = "workforce_payout_disputes",
  params = {}
}: {
  auth: AuthorizationContext;
  pageCode?: string;
  action: (form: FormData) => Promise<void>;
  params?: { status?: string; q?: string; run?: string; page?: string; size?: string; station?: string; category?: string; month?: string };
}) {
  if (!supabaseAdmin) return <p role="alert">Payout disputes are unavailable.</p>;

  const company = requireCompanyId(auth);
  const financeAccess = pageCode === "workforce_payout_disputes" ? await loadDisputeFinanceAccess(auth) : null;
  const scope = auth.hasAllLocationAccess ? null : auth.locationScopeIds;
  const requestedStatus = params.status && params.status in STATUS_FILTERS ? params.status : "mine";
  const filteredStatuses = STATUS_FILTERS[requestedStatus];
  const { page, size } = readPaging(params.page, params.size, 25);
  const searching = Boolean((params.q || "").trim()) || requestedStatus === "mine" || Boolean(params.month);
  const payrollRun = uuid(params.run);
  const requestedStation = uuid(params.station);
  const category = params.category && params.category in CATEGORIES ? params.category : "";
  const raised = monthRange(params.month);

  let stationsQuery = supabaseAdmin.from("stations").select("id,station_code").eq("company_id", company)
    .order("station_code").limit(1000);
  if (scope) stationsQuery = stationsQuery.in("id", scope.length ? scope : ["00000000-0000-0000-0000-000000000000"]);
  const stationList = await stationsQuery;
  if (stationList.error) return <p role="alert">Payout dispute locations could not load. No changes were made.</p>;
  const permittedLocationIds = (stationList.data ?? []).map((row) => String(row.id));
  const locationFilterIds = permittedLocationIds.length ? permittedLocationIds : ["00000000-0000-0000-0000-000000000000"];
  const station = requestedStation && permittedLocationIds.includes(requestedStation) ? requestedStation : "";

  let disputeQuery = supabaseAdmin.from("workforce_payout_disputes").select("*").eq("company_id", company)
    .in("station_id", locationFilterIds);
  if (filteredStatuses) disputeQuery = disputeQuery.in("status", filteredStatuses);
  if (payrollRun) disputeQuery = disputeQuery.eq("payroll_run_id", payrollRun);
  if (station) disputeQuery = disputeQuery.eq("station_id", station);
  if (category) disputeQuery = disputeQuery.eq("category", category);

  let totalQuery = supabaseAdmin.from("workforce_payout_disputes").select("id", { count: "exact", head: true }).eq("company_id", company)
    .in("station_id", locationFilterIds);
  if (filteredStatuses) totalQuery = totalQuery.in("status", filteredStatuses);
  if (payrollRun) totalQuery = totalQuery.eq("payroll_run_id", payrollRun);
  if (station) totalQuery = totalQuery.eq("station_id", station);
  if (category) totalQuery = totalQuery.eq("category", category);

  const countsQuery = supabaseAdmin.from("workforce_payout_disputes").select("status").eq("company_id", company)
    .in("station_id", locationFilterIds).limit(10000);
  const ordered = disputeQuery.order("created_at", { ascending: false }).order("id");
  const [disputeResult, countsResult, totalResult, workflowResult] = await Promise.all([
    searching ? readAllRows(ordered) : ordered.range((page - 1) * size, page * size - 1),
    countsQuery,
    searching ? Promise.resolve({ count: 0, error: null }) : totalQuery,
    supabaseAdmin.from("workforce_payout_dispute_workflows")
      .select("id,station_id,initial_approver_role_ids,final_approver_role_ids,processor_role_ids,is_active,version")
      .eq("company_id", company)
      .eq("is_active", true)
  ]);
  if (disputeResult.error || countsResult.error || totalResult.error) {
    return <p role="alert">Payout disputes could not load. No changes were made.</p>;
  }

  const disputes = (disputeResult.data ?? []) as Row[];
  const stationCode = new Map(((stationList.data ?? []) as Array<{ id: string; station_code: string }>).map((row) => [row.id, row.station_code]));
  const workflowRows = workflowResult.error ? [] : (workflowResult.data ?? []) as Row[];
  const companyWorkflow = workflowRows.find((row) => !row.station_id);
  const stationWorkflows = new Map(workflowRows.filter((row) => row.station_id).map((row) => [String(row.station_id), row]));
  const currentWorkflow = (stationId: string) => stationWorkflows.get(stationId) ?? companyWorkflow;

  const routeStage = (status: string): WorkflowStage | null => {
    if (status === "open") return "initial";
    if (["in_review", "pending_final_approval"].includes(status)) return "final";
    if (["approved_for_processing", "processing", "processing_blocked"].includes(status)) return "processor";
    return null;
  };
  const routeRequests = disputes.flatMap((dispute) => {
    const stage = routeStage(String(dispute.status));
    return stage ? [{ dispute_id: dispute.id, stage }] : [];
  });
  const routeRoleByStage = new Map<string, string>();
  let routeResolutionFailed = false;
  if (routeRequests.length) {
    const routeResult = await supabaseAdmin.rpc("workforce_payout_dispute_route_roles", {
      p_company: company,
      p_requests: routeRequests
    });
    routeResolutionFailed = Boolean(routeResult.error);
    if (!routeResult.error) {
      for (const route of (routeResult.data ?? []) as Row[]) {
        if (route.role_id) routeRoleByStage.set(`${route.dispute_id}:${route.stage}`, String(route.role_id).toLowerCase());
      }
    }
  }

  const publicationIds = [...new Set(disputes.flatMap((dispute) => [dispute.publication_id, dispute.processed_publication_id]).filter(Boolean))];
  const publications = new Map<string, Row>();
  for (let index = 0; index < publicationIds.length; index += 100) {
    const loaded = await supabaseAdmin.from("workforce_payout_publications")
      .select("id,workforce_id,station_id,period_start,period_end,revision,published_at,snapshot")
      .eq("company_id", company)
      .in("id", publicationIds.slice(index, index + 100));
    if (loaded.error) return <p role="alert">Payout dispute publications could not load. No changes were made.</p>;
    for (const publication of loaded.data ?? []) publications.set(String(publication.id), publication);
  }

  const processorRows = disputes.filter((dispute) => ["approved_for_processing", "processing", "processing_blocked"].includes(dispute.status));
  const processorWorkforceIds = [...new Set(processorRows.map((dispute) => String(dispute.workforce_id)).filter(Boolean))];
  const revisedPublications: Row[] = [];
  for (let index = 0; index < processorWorkforceIds.length; index += 100) {
    const loaded = await supabaseAdmin.from("workforce_payout_publications")
      .select("id,workforce_id,station_id,period_start,period_end,revision,published_at,snapshot")
      .eq("company_id", company)
      .in("workforce_id", processorWorkforceIds.slice(index, index + 100))
      .order("published_at", { ascending: false })
      .limit(2000);
    if (loaded.error) return <p role="alert">Revised payout publications could not load. No changes were made.</p>;
    revisedPublications.push(...(loaded.data ?? []) as Row[]);
    for (const publication of loaded.data ?? []) publications.set(String(publication.id), publication);
  }
  const latestRevision = new Map<string, Row>();
  for (const dispute of processorRows) {
    const source = publications.get(String(dispute.publication_id));
    if (!source) continue;
    const candidate = revisedPublications
      .filter((publication) => isNewerPublication(publication, source, dispute))
      .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0))[0];
    if (candidate) latestRevision.set(String(dispute.id), candidate);
  }

  const eventsByDispute = new Map<string, Row[]>();
  const disputeIds = disputes.map((dispute) => String(dispute.id));
  for (let index = 0; index < disputeIds.length; index += 100) {
    const events = await supabaseAdmin.from("workforce_payout_dispute_events")
      .select("id,dispute_id,actor_name,portal,message,event_type,from_status,to_status,metadata,created_at")
      .eq("company_id", company)
      .in("dispute_id", disputeIds.slice(index, index + 100))
      .order("created_at", { ascending: false });
    if (events.error) continue;
    for (const event of events.data ?? []) {
      const key = String(event.dispute_id);
      const list = eventsByDispute.get(key) ?? [];
      list.push(event);
      eventsByDispute.set(key, list);
    }
  }

  const query = (params.q || "").trim().toLowerCase();
  const matched = disputes.filter((dispute) => {
    if (params.month && period(publications.get(String(dispute.publication_id))).start.slice(0,7) !== params.month) return false;
    if (requestedStatus === "mine") {
      const stage = routeStage(dispute.status);
      const selectedRole = routeRoleByStage.get(`${dispute.id}:${stage}`);
      const roles = stage === "final" && financeAccess ? disputeFinalRoleIds(auth.effectiveRoleIds, financeAccess, String(dispute.station_id)) : auth.effectiveRoleIds;
      if (!hasPermission(auth,pageCode,"edit") || !selectedRole || !roles.includes(selectedRole) || dispute.details?.awaiting_reply) return false;
      if (stage === "final" && (dispute.initial_reviewed_by===auth.userId || dispute.proposed_by===auth.userId)) return false;
      if (stage === "processor" && (dispute.initial_reviewed_by===auth.userId || dispute.final_approved_by===auth.userId || (dispute.processor_id && dispute.processor_id!==auth.userId))) return false;
    }
    const worker = record(record(publications.get(String(dispute.publication_id))?.snapshot).item);
    const searchable = [worker.worker_name, worker.dropx_id, dispute.reason, dispute.category]
      .map((value) => String(value ?? "").toLowerCase()).join(" ");
    return !query || searchable.includes(query);
  });
  const total = searching ? matched.length : totalResult.count ?? matched.length;
  const shown = searching ? matched.slice((page - 1) * size, page * size) : matched;
  const canEditDesk = hasPermission(auth, pageCode, "edit") && !auth.readOnly;
  const payoutPageCode = pageCode.startsWith("ops_") ? "ops_workforce_payouts" : "workforce_payouts";
  const canEditPayout = hasPermission(auth, payoutPageCode, "edit") && !auth.readOnly;
  const stageAllowed = (disputeId: string, stage: WorkflowStage) => {
    const selectedRole = routeRoleByStage.get(`${disputeId}:${stage}`);
    const dispute = disputes.find((row) => String(row.id) === disputeId);
    const actorRoles = stage === "final" && financeAccess
      ? disputeFinalRoleIds(auth.effectiveRoleIds, financeAccess, String(dispute?.station_id || ""))
      : auth.effectiveRoleIds;
    return Boolean(selectedRole && actorRoles.includes(selectedRole));
  };
  const configFor = (dispute: Row) => {
    const snapshot = record(dispute.workflow_snapshot);
    return roleIds(snapshot, "initial_approver_role_ids").length
      && roleIds(snapshot, "final_approver_role_ids").length
      && roleIds(snapshot, "processor_role_ids").length
      ? snapshot
      : currentWorkflow(String(dispute.station_id));
  };
  const monthOptions = Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - index);
    return date.toISOString().slice(0, 7);
  });
  const count = (statuses: string[]) => (countsResult.data ?? []).filter((row) => statuses.includes(row.status)).length;

  return (
    <div className={styles.desk}>
      <div className={styles.kpis}>
        <div><span>Initial review</span><strong>{count(["open"])}</strong></div>
        <div><span>Final approval</span><strong>{count(["in_review", "pending_final_approval"])}</strong></div>
        <div><span>Processing</span><strong>{count(["approved_for_processing", "processing", "processing_blocked"])}</strong></div>
        <div><span>Closed</span><strong>{count(["resolved", "rejected"])}</strong><a href="/payments/disputes?status=closed">View history</a></div>
        <p className={styles.flow}>Associate → Manager review → Finance approval → Accounts correction → Verified closure</p>
      </div>
      {workflowResult.error || !companyWorkflow ? (
        <div className={styles.configuration} role="status">
          <strong>Workflow setup required.</strong> Configure the company default and any station overrides in <a href="/settings/payout-disputes">Settings → Payout Dispute Workflow</a>. Existing disputes remain visible, but cannot advance without a configured route.
        </div>
      ) : null}
      {routeResolutionFailed ? (
        <div className={styles.configuration} role="alert">
          <strong>Approval routing could not be verified.</strong> Action buttons are hidden to prevent the wrong primary or fallback role from acting. Refresh the page; no dispute data was changed.
        </div>
      ) : null}
      <form method="get" className={styles.filters}>
        <input name="q" type="search" aria-label="Search disputes" placeholder="Search associate, DropX ID or reason" defaultValue={params.q} />
        <select name="status" aria-label="Dispute status" defaultValue={requestedStatus}>
          <option value="mine">Pending with me</option>
          <option value="active">All active stages</option>
          <option value="initial">Initial review</option>
          <option value="final">Final approval</option>
          <option value="processing">Processing</option>
          <option value="closed">All closed</option>
          <option value="resolved">Resolved / previously closed</option>
          <option value="rejected">Rejected</option>
          <option value="all">All statuses</option>
        </select>
        <select name="station" aria-label="Station" defaultValue={station}>
          <option value="">All stations</option>
          {[...stationCode].map(([id, code]) => <option key={id} value={id}>{code}</option>)}
        </select>
        <select name="category" aria-label="Category" defaultValue={category}>
          <option value="">All categories</option>
          {Object.entries(CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select name="month" aria-label="Pay period" defaultValue={raised ? params.month : ""}>
          <option value="">Any month</option>
          {monthOptions.map((month) => <option key={month} value={month}>{new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })}</option>)}
        </select>
        <input type="hidden" name="size" value={String(size)} />
        <button className="button">Apply</button>
        <a className="button secondary" href="/payments/disputes">Reset</a>
      </form>

      {shown.map((dispute) => {
        const publication = publications.get(String(dispute.publication_id));
        const worker = record(record(publication?.snapshot).item);
        const decoded = decodePayoutReviewReason(dispute.reason);
        const payoutPeriod = period(publication);
        const workerLabel = [worker.worker_name, worker.dropx_id].filter(Boolean).join(" · ") || "Associate";
        const status = dispute.status === "resolved" && dispute.legacy_resolution_unverified ? { label: "Closed previously", cls: styles.muted } : STATUS[dispute.status] ?? { label: String(dispute.status).replaceAll("_", " "), cls: styles.muted };
        const workflow = configFor(dispute);
        const hasWorkflow = Boolean(workflow);
        const disputeId = String(dispute.id);
        const canInitial = canEditDesk && hasWorkflow && stageAllowed(disputeId, "initial");
        const canFinal = canEditDesk && hasWorkflow && stageAllowed(disputeId, "final");
        const canProcess = canEditDesk && canEditPayout && hasWorkflow && stageAllowed(disputeId, "processor");
        const sameInitialActor = dispute.initial_reviewed_by === auth.userId || dispute.proposed_by === auth.userId;
        const sameApprovalActor = sameInitialActor || dispute.final_approved_by === auth.userId;
        const plan = record(dispute.correction_plan);        const result = record(dispute.processing_result);
        const candidate = latestRevision.get(String(dispute.id));
        const beforePaise = netPaise(publication);
        const afterPaise = netPaise(candidate);
        const events = eventsByDispute.get(String(dispute.id)) ?? [];
        const editorMonth = payoutPeriod.start ? payoutPeriod.start.slice(0, 7) : "";
        const editorHref = `/payments/workforce-payouts?${new URLSearchParams({
          ...(editorMonth ? { month: editorMonth } : {}),
          dispute: String(dispute.id),
          q: String(worker.dropx_id || "")
        }).toString()}`;
        return (
          <details className={`${styles.card} ${styles.ticket}`} key={dispute.id}>
            <summary><header>
              <div>
                <h2>{workerLabel}</h2>
                <small>Ticket {String(dispute.id).slice(0, 8).toUpperCase()} · </small>
                <small>
                  {payoutPeriod.start && payoutPeriod.end ? `${payoutPeriod.start} – ${payoutPeriod.end} · ` : ""}
                  {[stationCode.get(dispute.station_id), decoded.areas.join(" · ") || CATEGORIES[dispute.category] || String(dispute.category).replaceAll("_", " ")].filter(Boolean).join(" · ")} · raised {when(dispute.created_at)}
                </small>
              </div>
              <span className={`${styles.pill} ${status.cls}`}>{status.label}</span>
            </header><span className={styles.ticketMeta}>{dispute.details?.awaiting_reply ? "Awaiting associate reply" : dispute.processor_name || (routeStage(dispute.status)==="initial" ? "Initial reviewer" : routeStage(dispute.status)==="final" ? "Final approver" : "Payout processor")} · {Math.max(0,Math.floor((Date.now()-Date.parse(dispute.updated_at||dispute.created_at))/86400000))}d</span></summary>
            <div className={styles.ticketBody}>
            {decoded.reason ? <p>{decoded.reason}</p> : null}
            <GuidedDisputeReview id={disputeId} version={dispute.version || 1} details={dispute.details?.schema===3?dispute.details:{...dispute.details,...plan.claim}} editable={dispute.status==="open" && canInitial} action={action}/>

            {["pending_final_approval", "in_review", "approved_for_processing", "processing", "processing_blocked", "resolved"].includes(dispute.status) && dispute.proposed_decision ? (
              <div className={styles.proposal}>
                <b>{dispute.initial_reviewed_by_name || dispute.proposed_by_name}</b> proposed <b>{dispute.proposed_decision === "rejected" ? "rejection" : "a correction"}</b>
                {dispute.proposed_note ? <>: “{dispute.proposed_note}”</> : null} <small>{when(dispute.initial_reviewed_at || dispute.proposed_at)}</small>
                {Object.keys(plan).length ? (
                  <>
                    {(Array.isArray(plan.items) && plan.items.length ? plan.items : [plan]).map((item: Row, index: number) => <dl className={styles.plan} key={index}>
                      <div><dt>Disputed item</dt><dd>{String(item.target_field || "—")}</dd></div>
                      <div><dt>Current{item.unit ? ` (${item.unit === "rupees" ? "₹" : item.unit})` : ""}</dt><dd>{item.current_value == null ? "—" : String(item.current_value)}</dd></div>
                      <div><dt>Corrected value</dt><dd>{item.proposed_value == null ? "—" : String(item.proposed_value)}</dd></div>
                      {item.unit_rate != null && !["₹","rupees"].includes(item.unit) ? <div><dt>Applicable rate</dt><dd>₹{String(item.unit_rate)}</dd></div> : null}
                    </dl>)}
                    {plan.expected_delta_paise != null ? <p><b>Total expected net change:</b> {moneyFromPaise(plan.expected_delta_paise)}</p> : null}
                    {plan.totals?<p>Gross ₹{plan.totals.gross_before} → ₹{plan.totals.gross_after} · Deductions ₹{plan.totals.deductions_before} → ₹{plan.totals.deductions_after} · Net ₹{plan.totals.net_before} → ₹{plan.totals.net_after}</p>:null}
                  </>
                ) : null}
              </div>
            ) : null}

            {dispute.final_approved_at && dispute.status !== "rejected" ? (
              <p className={styles.approval}><b>Final approval:</b> {dispute.final_approved_by_name} · {when(dispute.final_approved_at)}</p>
            ) : null}
            {dispute.status === "rejected" ? (
              <p className={styles.proposal}><b>Final decision:</b> “{dispute.resolution || dispute.proposed_note}”{dispute.final_approved_by_name || dispute.approved_by_name ? <small> · approved by {dispute.final_approved_by_name || dispute.approved_by_name}</small> : null}</p>
            ) : null}
            {dispute.status === "resolved" ? (
              <div className={styles.resolution}>
                <p><b>{dispute.legacy_resolution_unverified ? "Closed previously · no new payout adjustment" : "Processor-applied correction · revised publication and net change system-verified"}</b></p>
                {dispute.resolution ? <p>“{dispute.resolution}”</p> : null}
                {!dispute.legacy_resolution_unverified && result.verified_before_net_paise != null ? (
                  <p>{moneyFromPaise(result.verified_before_net_paise)} → {moneyFromPaise(result.verified_after_net_paise)} · change {moneyFromPaise(result.verified_delta_paise)}</p>
                ) : null}
                {dispute.processor_name ? <small>Processed by {dispute.processor_name} · {when(dispute.processed_at)}</small> : null}
              </div>
            ) : null}

            {dispute.status === "open" ? (
              canInitial ? (
                <div className={styles.initialActions}>
                  <details>
                    <summary>Propose rejection</summary>
                    <form id={`reject-${disputeId}`} action={action} className={styles.simpleAction}>
                      <input name="dispute_id" type="hidden" value={dispute.id} />
                      <input name="expected_version" type="hidden" value={String(dispute.version || 1)} />
                      <input name="note" required minLength={10} maxLength={1000} placeholder="Reason the associate will see (at least 10 characters)" aria-label="Rejection reason" />
                      <button className="button secondary" name="transition" value="propose_rejection">Send rejection for final approval</button>
                    </form>
                  </details>
                  <form action={action} className={styles.simpleAction}><input name="dispute_id" type="hidden" value={dispute.id}/><input name="expected_version" type="hidden" value={dispute.version}/><input name="note" minLength={5} maxLength={1000} required placeholder="What should the associate clarify?" aria-label="Clarification question"/><button name="transition" value="request_clarification" className="button secondary">Ask associate</button></form>
                </div>
              ) : <p className={styles.hint}>{hasWorkflow ? "Waiting for a configured initial approver." : "No workflow is configured for this station."}</p>
            ) : null}

            {["in_review", "pending_final_approval"].includes(dispute.status) ? (
              sameInitialActor ? <p className={styles.hint}>You performed the initial review. A different final approver must decide.</p>
                : canFinal ? (
                  <div className={styles.finalActions}>
                    <form id={`final-${disputeId}`} action={action} className={styles.simpleAction}>
                      <input name="dispute_id" type="hidden" value={dispute.id} />
                      <input name="expected_version" type="hidden" value={String(dispute.version || 1)} />
                      <input name="note" maxLength={1000} placeholder="Final approval note (optional)" aria-label="Final approval note" />
                      <label><input type="checkbox" name="evidence_reviewed" required/> Evidence and payout impact checked</label>
                      <button className="button" name="transition" value="approve_final">{dispute.proposed_decision === "rejected" ? "Confirm rejection" : "Approve correction for processing"}</button>
                    </form>
                    <form action={action} className={styles.simpleAction}>
                      <input name="dispute_id" type="hidden" value={dispute.id} />
                      <input name="expected_version" type="hidden" value={String(dispute.version || 1)} />
                      <input name="note" required minLength={5} maxLength={1000} placeholder="Why this needs rework" aria-label="Send-back reason" />
                      <button className="button secondary" name="transition" value="send_back">Send back</button>
                    </form>
                  </div>
                ) : <p className={styles.hint}>Waiting for a configured final approver.</p>
            ) : null}

            {["approved_for_processing", "processing_blocked"].includes(dispute.status) ? (
              <>
                {dispute.status === "processing_blocked" && dispute.processing_note ? <p className={styles.proposal}><b>Processing blocker:</b> {dispute.processing_note}</p> : null}
                {sameApprovalActor ? <p className={styles.hint}>You approved this dispute. A different payout processor must apply the correction.</p>
                  : canProcess ? (
                    <form action={action} className={styles.simpleAction}>
                      <input name="dispute_id" type="hidden" value={dispute.id} />
                      <input name="expected_version" type="hidden" value={String(dispute.version || 1)} />
                      <input name="note" maxLength={1000} placeholder="Processing note (optional)" aria-label="Processing note" />
                      <button className="button" name="transition" value="claim_processing">Claim processing</button>
                    </form>
                  ) : <p className={styles.hint}>{canEditPayout ? "Waiting for a configured payout processor." : "Processing requires Workforce Payouts edit permission."}</p>}
              </>
            ) : null}

            {dispute.status === "processing" ? (
              dispute.processor_id !== auth.userId ? (
                <p className={styles.hint}>Processing is assigned to {dispute.processor_name || "another processor"}.</p>
              ) : (
                <div className={styles.processingPanel}>
                  <div>
                    <b>Correct the authoritative payout source</b>
                    <p>Do not edit the published snapshot. Update attendance, production, rate, additional payment or deduction in Workforce Payouts, then publish the revised payout.</p>
                    <a className="button secondary" href={editorHref}>Open payout editor · {worker.dropx_id || "associate"}</a>
                  </div>
                  {candidate && beforePaise != null && afterPaise != null ? (
                    <form action={action} className={styles.verifyAction}>
                      <p><b>Revised publication detected:</b> revision {candidate.revision} · {moneyFromPaise(beforePaise)} → {moneyFromPaise(afterPaise)}</p>
                      <input name="dispute_id" type="hidden" value={dispute.id} />
                      <input name="expected_version" type="hidden" value={String(dispute.version || 1)} />
                      <input name="processed_publication_id" type="hidden" value={candidate.id} />
                      <input name="before_net_paise" type="hidden" value={String(beforePaise)} />
                      <input name="after_net_paise" type="hidden" value={String(afterPaise)} />
                      <input name="note" required minLength={10} maxLength={1000} placeholder="What was corrected (shown to associate)" aria-label="Completion note" />
                      <button className="button" name="transition" value="complete_processing">Confirm verified net change and resolve</button>
                    </form>
                  ) : <p className={styles.hint}>No newer publication for the same person, station and payout period yet.</p>}
                  <form action={action} className={styles.simpleAction}>
                    <input name="dispute_id" type="hidden" value={dispute.id} />
                    <input name="expected_version" type="hidden" value={String(dispute.version || 1)} />
                    <input name="note" required minLength={5} maxLength={1000} placeholder="What is blocking processing?" aria-label="Processing blocker" />
                    <button className="button secondary" name="transition" value="block_processing">Mark blocked</button>
                  </form>
                </div>
              )
            ) : null}

            {events.length ? (
              <details className={styles.history}>
                <summary>Workflow history ({events.length})</summary>
                <ol>{events.map((event) => <li key={event.id}><span>{event.message}</span><small>{event.actor_name} · {when(event.created_at)}</small></li>)}</ol>
              </details>
            ) : null}
            {((canFinal&&["pending_final_approval","in_review"].includes(dispute.status))||(canProcess&&["approved_for_processing","processing","processing_blocked"].includes(dispute.status)))&&plan.schema!==3?<form action={action} className={styles.simpleAction}><input name="dispute_id" type="hidden" value={dispute.id}/><input name="expected_version" type="hidden" value={dispute.version}/><input name="note" type="hidden" value="Revalidate the specific item and recalculate gross, deductions and net using current evidence."/><button name="transition" value="return_review" className="button secondary">Return for guided recalculation</button></form>:null}
            </div>
          </details>
        );
      })}

      {!shown.length ? <section className={styles.card}>No disputes match this view.</section> : null}
      <section className={styles.card} style={{ padding: 0 }}>
        <UrlPager basePath="/payments/disputes" params={{ status: requestedStatus, q: params.q, run: payrollRun || undefined, station: station || undefined, category: category || undefined, month: raised ? params.month : undefined }} total={total} page={page} size={size} label="disputes" />
      </section>
    </div>
  );
}

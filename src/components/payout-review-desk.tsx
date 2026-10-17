import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { decodePayoutReviewReason } from "@/lib/payout-review-display";
import { supabaseAdmin } from "@/lib/supabase-admin";
import styles from "./payout-review-desk.module.css";
import { UrlPager, readPaging } from "./url-pager";

type Row = Record<string, any>;

const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: "Needs review", cls: styles.warn },
  in_review: { label: "Awaiting approval", cls: styles.info },
  resolved: { label: "Resolved", cls: styles.good },
  rejected: { label: "Rejected", cls: styles.muted },
};
const when = (v: string | null) => (v ? new Date(v).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

export async function PayoutReviewDesk({
  auth,
  action,
  params = {}
}: {
  auth: AuthorizationContext;
  action: (form: FormData) => Promise<void>;
  params?: { status?: string; q?: string; run?: string; page?: string; size?: string };
}) {
  if (!supabaseAdmin) return <p role="alert">Payout disputes are unavailable.</p>;

  const company = requireCompanyId(auth);
  const scope = auth.hasAllLocationAccess ? null : auth.locationScopeIds;
  const requestedStatus = params.status || "open";
  let disputeQuery = supabaseAdmin.from("workforce_payout_disputes").select("*").eq("company_id", company);
  if (scope) disputeQuery = disputeQuery.in("station_id", scope.length ? scope : ["00000000-0000-0000-0000-000000000000"]);
  if (requestedStatus === "open") disputeQuery = disputeQuery.in("status", ["open", "in_review"]);
  else if (requestedStatus !== "all") disputeQuery = disputeQuery.eq("status", requestedStatus);
  if (params.run && /^[0-9a-f-]{36}$/i.test(params.run)) disputeQuery = disputeQuery.eq("payroll_run_id", params.run);
  // Without a search, read only the requested page from the database; a name search needs the snapshot,
  // so it reads a bounded set (500 newest) and filters that.
  const { page, size } = readPaging(params.page, params.size, 25);
  const searching = Boolean((params.q || "").trim());
  const ordered = disputeQuery.order("created_at", { ascending: false }).order("id");
  const [disputeResult, counts, totalResult] = await Promise.all([
    searching ? ordered.limit(500) : ordered.range((page - 1) * size, page * size - 1),
    (scope ? supabaseAdmin.from("workforce_payout_disputes").select("status").eq("company_id", company).in("station_id", scope.length ? scope : ["00000000-0000-0000-0000-000000000000"]) : supabaseAdmin.from("workforce_payout_disputes").select("status").eq("company_id", company)).in("status", ["open", "in_review"]),
    searching ? Promise.resolve({ count: 0, error: null }) : (() => {
      let c = supabaseAdmin!.from("workforce_payout_disputes").select("id", { count: "exact", head: true }).eq("company_id", company);
      if (scope) c = c.in("station_id", scope.length ? scope : ["00000000-0000-0000-0000-000000000000"]);
      if (requestedStatus === "open") c = c.in("status", ["open", "in_review"]);
      else if (requestedStatus !== "all") c = c.eq("status", requestedStatus);
      if (params.run && /^[0-9a-f-]{36}$/i.test(params.run)) c = c.eq("payroll_run_id", params.run);
      return c;
    })(),
  ]);
  if (disputeResult.error || counts.error || totalResult.error) return <p role="alert">Payout disputes could not load. No changes were made.</p>;
  const disputes = (disputeResult.data ?? []) as Row[];

  // Only the publications these disputes point at; never the whole publication history.
  const publicationIds = [...new Set(disputes.map((d) => d.publication_id).filter(Boolean))];
  const publications = new Map<string, Row>();
  for (let i = 0; i < publicationIds.length; i += 100) {
    const r = await supabaseAdmin.from("workforce_payout_publications").select("id,period_start,period_end,snapshot").eq("company_id", company).in("id", publicationIds.slice(i, i + 100));
    if (r.error) return <p role="alert">Payout disputes could not load. No changes were made.</p>;
    for (const p of r.data ?? []) publications.set(p.id, p);
  }

  const query = (params.q || "").trim().toLowerCase();
  const matched = disputes.filter((dispute) => {
    const worker = publications.get(dispute.publication_id)?.snapshot?.item;
    const searchable = [worker?.worker_name, worker?.dropx_id, dispute.reason, dispute.category].map((v) => String(v ?? "").toLowerCase()).join(" ");
    return !query || searchable.includes(query);
  });
  const total = searching ? matched.length : totalResult.count ?? matched.length;
  const shown = searching ? matched.slice((page - 1) * size, page * size) : matched;
  const canDecide = hasPermission(auth, "workforce_payout_disputes", "edit") && !auth.readOnly;
  const open = (counts.data ?? []).filter((r) => r.status === "open").length;
  const awaiting = (counts.data ?? []).filter((r) => r.status === "in_review").length;

  return (
    <div className={styles.desk}>
      <div className={styles.kpis}>
        <div><span>Needs review</span><strong>{open}</strong></div>
        <div><span>Awaiting approval</span><strong>{awaiting}</strong></div>
        <div className={styles.flow}>Associate raises in DropX One → reviewer proposes → second reviewer approves → associate sees the decision</div>
      </div>
      <form method="get" className={styles.filters}>
        <input name="q" aria-label="Search disputes" placeholder="Associate, ID or reason" defaultValue={params.q} />
        <select name="status" aria-label="Dispute status" defaultValue={requestedStatus}>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
        <button className="button secondary">Apply</button>
      </form>

      {shown.map((dispute) => {
        const publication = publications.get(dispute.publication_id);
        const worker = publication?.snapshot?.item;
        const run = publication?.snapshot?.run;
        const decoded = decodePayoutReviewReason(dispute.reason);
        const periodStart = run?.period_start ?? publication?.period_start;
        const periodEnd = run?.period_end ?? publication?.period_end;
        const workerLabel = [worker?.worker_name, worker?.dropx_id].filter(Boolean).join(" · ") || "Associate";
        const status = STATUS[dispute.status] ?? { label: String(dispute.status), cls: styles.muted };
        const mineProposal = dispute.proposed_by === auth.userId;
        return (
          <article className={styles.card} key={dispute.id}>
            <header>
              <div>
                <h2>{workerLabel}</h2>
                <small>
                  {periodStart && periodEnd ? `${periodStart} – ${periodEnd} · ` : ""}
                  {decoded.areas.join(" · ") || String(dispute.category).replaceAll("_", " ")} · raised {when(dispute.created_at)}
                </small>
              </div>
              <span className={`${styles.pill} ${status.cls}`}>{status.label}</span>
            </header>
            {decoded.reason ? <p>{decoded.reason}</p> : null}
            {dispute.status === "in_review" && dispute.proposed_decision ? (
              <p className={styles.proposal}>
                <b>{dispute.proposed_by_name}</b> proposes to <b>{dispute.proposed_decision === "resolved" ? "resolve" : "reject"}</b>: “{dispute.proposed_note}” <small>{when(dispute.proposed_at)}</small>
              </p>
            ) : null}
            {["resolved", "rejected"].includes(dispute.status) && dispute.resolution ? (
              <p className={styles.proposal}>Decision: “{dispute.resolution}”{dispute.approved_by_name ? <small> · approved by {dispute.approved_by_name}</small> : null}</p>
            ) : null}
            {canDecide && dispute.status === "open" ? (
              <form action={action} className={styles.decisions}>
                <input name="step" type="hidden" value="propose" />
                <input name="dispute_id" type="hidden" value={dispute.id} />
                <input name="note" required minLength={10} maxLength={1000} placeholder="Decision the associate will see (at least 10 characters)" aria-label="Decision note" />
                <button className="button secondary" name="decision" value="rejected">Propose reject</button>
                <button className="button" name="decision" value="resolved">Propose resolve</button>
              </form>
            ) : null}
            {canDecide && dispute.status === "in_review" ? (
              mineProposal ? (
                <p className={styles.hint}>You proposed this decision. Another reviewer approves it.</p>
              ) : (
                <form action={action} className={styles.decisions}>
                  <input name="dispute_id" type="hidden" value={dispute.id} />
                  <input name="note" maxLength={1000} placeholder="Note (required to send back)" aria-label="Approval note" />
                  <button className="button secondary" name="step" value="send_back">Send back</button>
                  <button className="button" name="step" value="approve">Approve decision</button>
                </form>
              )
            ) : null}
          </article>
        );
      })}

      {!shown.length ? <section className={styles.card}>No disputes match this view.</section> : null}
      <section className={styles.card} style={{ padding: 0 }}>
        <UrlPager basePath="/payments/disputes" params={{ status: params.status, q: params.q, run: params.run }} total={total} page={page} size={size} label="disputes" />
      </section>
    </div>
  );
}

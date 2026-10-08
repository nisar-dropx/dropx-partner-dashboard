import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { decodePayoutReviewReason } from "@/lib/payout-review-display";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import styles from "./payout-review-desk.module.css";

type Row = Record<string, any>;

function disputeStatus(value: unknown) {
  return String(value) === "in_review" ? "open" : String(value).replaceAll("_", " ");
}

export async function PayoutReviewDesk({
  auth,
  action,
  params = {}
}: {
  auth: AuthorizationContext;
  action: (form: FormData) => Promise<void>;
  params?: { status?: string; q?: string; run?: string };
}) {
  if (!supabaseAdmin) return <p role="alert">Payout disputes are unavailable.</p>;

  const company = requireCompanyId(auth);
  const scope = auth.hasAllLocationAccess ? null : auth.locationScopeIds;
  const scoped = (query: any) =>
    scope
      ? query.in("station_id", scope.length ? scope : ["00000000-0000-0000-0000-000000000000"])
      : query;
  const [disputeResult, publicationResult] = await Promise.all([
    readAllRows(
      scoped(supabaseAdmin.from("workforce_payout_disputes").select("*").eq("company_id", company))
        .order("created_at", { ascending: false })
        .order("id")
    ),
    readAllRows(
      scoped(supabaseAdmin.from("workforce_payout_publications").select("*").eq("company_id", company))
        .order("published_at", { ascending: false })
        .order("id")
    )
  ]);

  if (disputeResult.error || publicationResult.error) {
    return <p role="alert">Payout disputes could not load. No changes were made.</p>;
  }

  const disputes = (disputeResult.data ?? []) as Row[];
  const publications = new Map(
    ((publicationResult.data ?? []) as Row[]).map((publication) => [publication.id, publication])
  );
  const requestedStatus = params.status || "open";
  const query = (params.q || "").trim().toLowerCase();
  const shown = disputes.filter((dispute) => {
    const publication = publications.get(dispute.publication_id);
    const worker = publication?.snapshot?.item;
    const matchesStatus =
      requestedStatus === "all" ||
      (requestedStatus === "open" && ["open", "in_review"].includes(dispute.status)) ||
      dispute.status === requestedStatus;
    const searchable = [worker?.worker_name, worker?.dropx_id, dispute.reason, dispute.category]
      .map((value) => String(value ?? "").toLowerCase())
      .join(" ");
    return matchesStatus && (!params.run || dispute.payroll_run_id === params.run) && (!query || searchable.includes(query));
  });
  const canDecide = hasPermission(auth, "workforce_payout_disputes", "edit") && !auth.readOnly;

  return (
    <div className={styles.desk}>
      <form method="get" className={styles.filters}>
        <input
          name="q"
          aria-label="Search disputes"
          placeholder="Associate, ID or reason"
          defaultValue={params.q}
        />
        <select name="status" aria-label="Dispute status" defaultValue={requestedStatus}>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
        <button className="button secondary">Apply</button>
      </form>
      <p>
        {shown.length} shown · {disputes.filter((dispute) => ["open", "in_review"].includes(dispute.status)).length} active disputes
      </p>

      {shown.map((dispute) => {
        const publication = publications.get(dispute.publication_id);
        const worker = publication?.snapshot?.item;
        const run = publication?.snapshot?.run;
        const decoded = decodePayoutReviewReason(dispute.reason);
        const periodStart = run?.period_start ?? publication?.period_start;
        const periodEnd = run?.period_end ?? publication?.period_end;
        const workerLabel = [worker?.worker_name, worker?.dropx_id].filter(Boolean).join(" · ") || "Associate";

        return (
          <article className={styles.card} key={dispute.id}>
            <header>
              <div>
                <h2>{workerLabel}</h2>
                <small>
                  {periodStart && periodEnd ? `${periodStart} – ${periodEnd} · ` : ""}
                  {decoded.areas.join(" · ") || String(dispute.category).replaceAll("_", " ")}
                </small>
              </div>
              <strong>{disputeStatus(dispute.status)}</strong>
            </header>
            {decoded.reason ? <p>{decoded.reason}</p> : null}
            {canDecide && ["open", "in_review"].includes(dispute.status) ? (
              <form action={action} className={styles.decisions}>
                <input name="operation" type="hidden" value="decision" />
                <input name="dispute_id" type="hidden" value={dispute.id} />
                <button className="button secondary" name="decision" value="rejected">
                  Reject
                </button>
                <button className="button" name="decision" value="resolved">
                  Resolve
                </button>
              </form>
            ) : null}
          </article>
        );
      })}

      {!shown.length ? <section className={styles.card}>No disputes match this view.</section> : null}
    </div>
  );
}

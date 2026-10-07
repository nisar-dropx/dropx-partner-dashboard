import { NextRequest } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePaymentStatus } from "./workforce-payment-status";
import { payoutReviewState } from "./payout-dispute";

type Row = Record<string, any>;

export async function payoutIdentity(request: NextRequest) {
  const account = await requireConnectAccount(
    request.nextUrl.searchParams.get("profileType") as ConnectAccount["profileType"],
    request.nextUrl.searchParams.get("accountId") || ""
  );
  if (account.workspace !== "workforce" || !account.pageAccess.includes("earnings") || !supabaseAdmin) {
    throw new Error("Payout access is unavailable.");
  }
  let query = supabaseAdmin.from("workforce").select("id").eq("company_id", account.companyId).is("deleted_at", null).neq("migration_state", "reclassified");
  query = account.profileType === "workforce"
    ? query.eq("id", account.id)
    : query.eq("source_profile_type", account.profileType).eq("source_profile_id", account.id);
  const result = await query.maybeSingle();
  if (result.error || !result.data) throw new Error("Your Workforce identity could not be verified.");
  return { company: account.companyId, worker: result.data.id };
}

async function rows(query: any): Promise<Row[]> {
  const result: Row[] = [];
  for (let offset = 0; offset < 20_000; offset += 500) {
    const page = await query.range(offset, offset + 499);
    if (page.error) throw new Error("Payout details could not be loaded. Please retry.");
    result.push(...(page.data ?? []));
    if ((page.data ?? []).length < 500) return result;
  }
  throw new Error("Payout history needs team review.");
}

function detailLines(lines: Row[]) {
  return lines.map((line) => {
    const snapshot = line.calculation_snapshot ?? {};
    const counts = snapshot.counts ?? {};
    return {
      date: line.work_date,
      type: line.source_type,
      providerId: line.provider_member_id,
      providerName: snapshot.providerMemberName || null,
      delivery: Number(counts.totalDelivery ?? line.shipment_count ?? 0),
      cReturn: Number(counts.customerReturn ?? 0),
      mfn: Number(counts.mfn ?? 0),
      mfnReturn: Number(counts.mfnReturn ?? 0),
      base: Number(line.base_amount),
      incentive: Number(line.incentive_amount),
      adjustment: Number(line.adjustment_amount),
      net: Number(line.net_amount),
      category: snapshot.correction_kind || snapshot.category || line.source_type,
      reason: snapshot.correction_reason || snapshot.reason || "",
      originalAmount: snapshot.original_adjustment ?? null,
    };
  });
}

function payoutOutput({
  id,
  publication,
  item,
  lines,
  from,
  to,
  status,
  runStatus,
  revisionPending,
  paymentDate = null,
  paymentReference = null,
  disputes,
  events,
  payoutSlipAvailable,
}: {
  id: string;
  publication: Row | null;
  item: Row;
  lines: Row[];
  from: string;
  to: string;
  status: string;
  runStatus: string;
  revisionPending: boolean;
  paymentDate?: unknown;
  paymentReference?: unknown;
  disputes: Row[];
  events: Row[];
  payoutSlipAvailable: boolean;
}) {
  const detail = detailLines(lines);
  const reviewState = payoutReviewState({
    hasPublication: Boolean(publication),
    reviewUntil: publication?.review_until,
    runStatus,
    revisionPending,
  });
  return {
    id,
    publicationId: publication?.id ?? null,
    revision: publication?.revision ?? null,
    name: item.worker_name,
    dropxId: item.dropx_id,
    station: item.station_code,
    from,
    to,
    status,
    reviewUntil: publication?.review_until ?? null,
    publishedAt: publication?.published_at ?? null,
    reviewState,
    canDispute: reviewState === "open",
    revisionPending,
    payoutSlipAvailable,
    bankDestinationAvailable: publication?.publication_kind !== "worksheet"
      || Object.prototype.hasOwnProperty.call(item, "bank_account_no")
      || Object.prototype.hasOwnProperty.call(item, "ifsc_code"),
    bankAccount: String(item.bank_account_no || ""),
    ifsc: item.ifsc_code || "",
    providerIds: item.provider_member_ids || [],
    days: Number(item.work_days),
    base: Number(item.base_amount),
    incentive: Number(item.incentive_amount),
    additions: Number(item.adjustment_amount),
    deductions: Number(item.deduction_amount),
    gross: Number(item.gross_amount),
    net: Number(item.net_amount),
    paymentDate,
    paymentReference,
    counts: {
      delivery: detail.reduce((sum, line) => sum + line.delivery, 0),
      cReturn: detail.reduce((sum, line) => sum + line.cReturn, 0),
      mfn: detail.reduce((sum, line) => sum + line.mfn, 0),
      mfnReturn: detail.reduce((sum, line) => sum + line.mfnReturn, 0),
    },
    lines: detail,
    disputes: disputes.map((dispute) => ({
      ...dispute,
      events: events.filter((event) => event.dispute_id === dispute.id),
    })),
  };
}

export async function loadAssociatePayouts(company: string, worker: string): Promise<Row[]> {
  const db = supabaseAdmin!;
  const publications = await rows(db.from("workforce_payout_publications").select("*").eq("company_id", company).eq("workforce_id", worker).order("published_at", { ascending: false }).order("id"));
  const items = await rows(db.from("workforce_payroll_items").select("*").eq("company_id", company).eq("workforce_id", worker).order("created_at", { ascending: false }).order("id"));
  const disputes = await rows(db.from("workforce_payout_disputes").select("id,publication_id,payroll_run_id,category,reason,status,resolution,created_at,updated_at").eq("company_id", company).eq("workforce_id", worker).order("created_at").order("id"));
  const runIds = [...new Set([...publications, ...items].map((row) => row.payroll_run_id).filter(Boolean))];
  const runs: Row[] = [];
  const events: Row[] = [];
  for (let index = 0; index < runIds.length; index += 100) {
    runs.push(...await rows(db.from("workforce_payroll_runs").select("id,run_number,period_start,period_end,status,payment_reference,payment_date,paid_at,calculated_at").eq("company_id", company).in("id", runIds.slice(index, index + 100)).order("id")));
  }
  for (let index = 0; index < disputes.length; index += 100) {
    events.push(...await rows(db.from("workforce_payout_dispute_events").select("id,dispute_id,actor_name,portal,message,created_at").eq("company_id", company).in("dispute_id", disputes.slice(index, index + 100).map((dispute) => dispute.id)).order("created_at").order("id")));
  }

  const output: Row[] = [];
  const modernKeys = new Set<string>();
  for (const publication of publications) {
    const snapshot = publication.snapshot ?? {};
    if (publication.publication_kind !== "worksheet" && snapshot.schema_version !== 2) continue;
    const from = String(publication.period_start ?? snapshot.run?.period_start ?? "");
    const to = String(publication.period_end ?? snapshot.run?.period_end ?? "");
    const key = `${publication.workforce_id}|${publication.station_id}|${from}|${to}`;
    if (modernKeys.has(key)) continue;
    modernKeys.add(key);
    if (!snapshot.item || !from || !to) continue;
    const publicationIdsForPeriod = publications
      .filter((candidate) => {
        const candidateSnapshot = candidate.snapshot ?? {};
        if (candidate.publication_kind !== "worksheet" && candidateSnapshot.schema_version !== 2) return false;
        return candidate.workforce_id === publication.workforce_id
          && candidate.station_id === publication.station_id
          && String(candidate.period_start ?? candidateSnapshot.run?.period_start ?? "") === from
          && String(candidate.period_end ?? candidateSnapshot.run?.period_end ?? "") === to;
      })
      .map((candidate) => candidate.id);
    output.push(payoutOutput({
      id: `worksheet:${publication.id}`,
      publication,
      item: snapshot.item,
      lines: snapshot.lines ?? [],
      from,
      to,
      status: "For your review",
      runStatus: "review",
      revisionPending: false,
      disputes: disputes.filter((dispute) => publicationIdsForPeriod.includes(dispute.publication_id)),
      events,
      payoutSlipAvailable: false,
    }));
  }

  for (const run of runs) {
    const publication = publications.find((candidate) => candidate.payroll_run_id === run.id) ?? null;
    const current = items.find((item) => item.payroll_run_id === run.id);
    const final = ["approved", "paid"].includes(run.status);
    if ((!publication && !final) || run.status === "cancelled") continue;
    let item: Row | undefined = publication?.snapshot.item;
    let payoutLines: Row[] = publication?.snapshot.lines ?? [];
    let status = "For your review";
    let paymentDate: unknown = null;
    let paymentReference: unknown = null;
    if (final && current) {
      const finance = await db.from("payment_requests").select("status,processed_at,utr_cin").eq("company_id", company).eq("source_system", "WORKFORCE_PAYROLL").eq("source_id", current.id).maybeSingle();
      if (finance.error) throw new Error("Payment reconciliation could not load.");
      const state = workforcePaymentStatus(current as any, run as any, finance.data);
      if (!state) continue;
      item = current;
      status = state.statusLabel;
      paymentDate = state.paymentDate;
      paymentReference = state.paymentReference;
      payoutLines = await rows(db.from("workforce_payroll_lines").select("*").eq("company_id", company).eq("workforce_id", worker).eq("payroll_run_id", run.id).order("work_date").order("id"));
    }
    if (!item) continue;
    const revisionPending = Boolean(publication) && publication?.source_calculated_at !== run.calculated_at && !final;
    output.push(payoutOutput({
      id: run.id,
      publication,
      item,
      lines: payoutLines,
      from: run.period_start,
      to: run.period_end,
      status,
      runStatus: run.status,
      revisionPending,
      paymentDate,
      paymentReference,
      disputes: disputes.filter((dispute) => dispute.payroll_run_id === run.id),
      events,
      payoutSlipAvailable: true,
    }));
  }
  return output.sort((left, right) => right.to.localeCompare(left.to));
}

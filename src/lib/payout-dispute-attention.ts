import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { currentAccessSurface } from "@/lib/access-surface";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const PAYOUT_DISPUTE_ACTIVE_STATUSES = [
  "open",
  "in_review",
  "pending_final_approval",
  "approved_for_processing",
  "processing",
  "processing_blocked"
] as const;

export type PayoutDisputeWorkflowStage = "initial" | "final" | "processor";

export type PayoutDisputeAttentionRow = {
  id: string;
  status: string;
  station_id: string | null;
  initial_reviewed_by: string | null;
  proposed_by: string | null;
  final_approved_by: string | null;
  processor_id: string | null;
};

export type PayoutDisputeAttention = {
  pageCode: "ops_workforce_payout_disputes" | "workforce_payout_disputes";
  /** Non-terminal disputes in scope (never resolved/rejected). */
  active: number;
  /** Disputes still waiting on this actor's stage — the notification count. */
  awaitingYou: number;
  /** Bell/nav/Command Center count: pending for you when editable, else active pending. */
  pending: number;
  initial: number;
  final: number;
  processing: number;
  href: string;
  detail: string;
};

const FETCH_CAP = 2_000;
const ROUTE_CHUNK = 500;
const EMPTY_STATION = "00000000-0000-0000-0000-000000000000";

export function payoutDisputePageCode(surface: ReturnType<typeof currentAccessSurface> = currentAccessSurface()) {
  return surface === "ops" ? "ops_workforce_payout_disputes" : "workforce_payout_disputes";
}

export function payoutDisputeWorkflowStage(status: string): PayoutDisputeWorkflowStage | null {
  if (status === "open") return "initial";
  if (status === "in_review" || status === "pending_final_approval") return "final";
  if (status === "approved_for_processing" || status === "processing" || status === "processing_blocked") return "processor";
  return null;
}

export function summarizePayoutDisputeStatuses(rows: Array<{ status: string }>) {
  let initial = 0;
  let final = 0;
  let processing = 0;
  for (const row of rows) {
    const stage = payoutDisputeWorkflowStage(String(row.status || ""));
    if (stage === "initial") initial += 1;
    else if (stage === "final") final += 1;
    else if (stage === "processor") processing += 1;
  }
  return { active: initial + final + processing, initial, final, processing };
}

export function preferredPayoutDisputeHref(summary: { initial: number; final: number; processing: number; active: number }) {
  if (summary.initial && !summary.final && !summary.processing) return "/payments/disputes?status=initial";
  if (summary.final && !summary.initial && !summary.processing) return "/payments/disputes?status=final";
  if (summary.processing && !summary.initial && !summary.final) return "/payments/disputes?status=processing";
  return "/payments/disputes?status=active";
}

export function payoutDisputeAttentionDetail(summary: {
  active: number;
  awaitingYou: number;
  pending: number;
  initial: number;
  final: number;
  processing: number;
}) {
  const stages = [
    summary.initial ? `${summary.initial} initial` : null,
    summary.final ? `${summary.final} final` : null,
    summary.processing ? `${summary.processing} processing` : null
  ].filter(Boolean).join(" · ");
  if (summary.awaitingYou > 0) {
    return `${summary.awaitingYou} pending for you${summary.active !== summary.awaitingYou ? ` · ${summary.active} still open in scope` : ""}${stages ? ` (${stages})` : ""}`;
  }
  if (summary.pending > 0) {
    return `${summary.pending} pending${stages ? ` · ${stages}` : ""}`;
  }
  return summary.active > 0
    ? `${summary.active} open in scope · none pending for you${stages ? ` (${stages})` : ""}`
    : "0 pending";
}

function sameActor(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  return String(left).toLowerCase() === String(right).toLowerCase();
}

/**
 * Station filter matching the disputes desk:
 * - null = all company locations (hasAllLocationAccess)
 * - [] = no permitted stations / empty selection → count zero via sentinel
 * - ids = only those stations, intersected with the actor's location scope
 */
export function resolvePayoutDisputeStationFilter(
  authorization: Pick<AuthorizationContext, "hasAllLocationAccess" | "locationScopeIds">,
  stationIds?: string[] | null
): string[] | null {
  const authScope = authorization.hasAllLocationAccess ? null : authorization.locationScopeIds;
  if (stationIds != null) {
    if (!stationIds.length) return [];
    if (!authScope) return stationIds;
    const allowed = new Set(authScope);
    return stationIds.filter((id) => allowed.has(id));
  }
  return authScope;
}

/**
 * A dispute awaits this actor when the desk would enable their stage button:
 * first eligible workflow role matches, and distinct-person rules for final/processor hold.
 */
export function disputeAwaitsActor(
  row: PayoutDisputeAttentionRow,
  actorId: string | null | undefined,
  actorRoleIds: string[],
  routeRoleByStage: Map<string, string>,
  canProcessPayouts: boolean
) {
  const stage = payoutDisputeWorkflowStage(String(row.status || ""));
  if (!stage) return false;
  const role = routeRoleByStage.get(`${row.id}:${stage}`);
  if (!role || !actorRoleIds.includes(role)) return false;

  const sameInitial = sameActor(actorId, row.initial_reviewed_by) || sameActor(actorId, row.proposed_by);
  const sameFinal = sameActor(actorId, row.final_approved_by);
  if (stage === "final" && sameInitial) return false;
  if (stage === "processor") {
    if (!canProcessPayouts) return false;
    if (sameInitial || sameFinal) return false;
    // Claimed processing stays with the claimer; blocked/ready-to-claim remain role-routed.
    if (row.status === "processing" && row.processor_id && !sameActor(actorId, row.processor_id)) return false;
  }
  return true;
}

function emptyAttention(pageCode: PayoutDisputeAttention["pageCode"]): PayoutDisputeAttention {
  return {
    pageCode,
    active: 0,
    awaitingYou: 0,
    pending: 0,
    initial: 0,
    final: 0,
    processing: 0,
    href: "/payments/disputes?status=active",
    detail: "0 pending"
  };
}

export async function loadPayoutDisputeAttention(
  authorization: AuthorizationContext,
  options?: { stationIds?: string[] | null }
): Promise<PayoutDisputeAttention | null> {
  if (!supabaseAdmin || !authorization.companyId) return null;
  const pageCode = payoutDisputePageCode();
  if (!hasPermission(authorization, pageCode, "access")) return null;
  if (!authorization.hasAllLocationAccess && authorization.locationScopeIds.length === 0) {
    return emptyAttention(pageCode);
  }

  const company = requireCompanyId(authorization);
  const stationFilter = resolvePayoutDisputeStationFilter(authorization, options?.stationIds);
  if (stationFilter && stationFilter.length === 0) return emptyAttention(pageCode);

  let query = supabaseAdmin
    .from("workforce_payout_disputes")
    .select("id,status,station_id,initial_reviewed_by,proposed_by,final_approved_by,processor_id")
    .eq("company_id", company)
    .in("status", [...PAYOUT_DISPUTE_ACTIVE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(FETCH_CAP);

  if (stationFilter) {
    query = query.in("station_id", stationFilter.length ? stationFilter : [EMPTY_STATION]);
  }

  const loaded = await query;
  if (loaded.error || !loaded.data) return null;
  if (loaded.data.length >= FETCH_CAP) {
    console.warn(
      `[payout-dispute-attention] company ${company} hit the ${FETCH_CAP}-row active dispute fetch cap — badge counts may be incomplete.`
    );
  }

  const rows = loaded.data as PayoutDisputeAttentionRow[];
  const summary = summarizePayoutDisputeStatuses(rows);
  const canEditDesk = hasPermission(authorization, pageCode, "edit") && !authorization.readOnly;
  const payoutPageCode = pageCode.startsWith("ops_") ? "ops_workforce_payouts" : "workforce_payouts";
  const canProcessPayouts = hasPermission(authorization, payoutPageCode, "edit") && !authorization.readOnly;
  const actorRoles = authorization.effectiveRoleIds.map((id) => String(id).toLowerCase());

  const routeRoleByStage = new Map<string, string>();
  let awaitingYou = 0;
  let routingFailed = false;
  if (canEditDesk && rows.length) {
    const requests = rows.flatMap((row) => {
      const stage = payoutDisputeWorkflowStage(String(row.status || ""));
      return stage ? [{ dispute_id: row.id, stage }] : [];
    });
    for (let index = 0; index < requests.length; index += ROUTE_CHUNK) {
      const chunk = requests.slice(index, index + ROUTE_CHUNK);
      const routed = await supabaseAdmin.rpc("workforce_payout_dispute_route_roles", {
        p_company: company,
        p_requests: chunk
      });
      if (routed.error) {
        // Fail closed for personal awaiting counts; still surface station active totals.
        routeRoleByStage.clear();
        routingFailed = true;
        awaitingYou = 0;
        break;
      }
      for (const route of (routed.data ?? []) as Array<{ dispute_id?: string; stage?: string; role_id?: string }>) {
        if (route.dispute_id && route.stage && route.role_id) {
          routeRoleByStage.set(`${route.dispute_id}:${route.stage}`, String(route.role_id).toLowerCase());
        }
      }
    }
    if (!routingFailed) {
      awaitingYou = rows.filter((row) =>
        disputeAwaitsActor(row, authorization.userId, actorRoles, routeRoleByStage, canProcessPayouts)
      ).length;
    }
  }

  const hrefFocus = canEditDesk && awaitingYou > 0
    ? summarizePayoutDisputeStatuses(
      rows.filter((row) =>
        disputeAwaitsActor(row, authorization.userId, actorRoles, routeRoleByStage, canProcessPayouts)
      )
    )
    : summary;

  const personalPending = canEditDesk ? awaitingYou : 0;
  // Notifications count only pending work — never resolved/rejected (those are not loaded),
  // and for editors never tickets already past their stage.
  const pending = canEditDesk ? personalPending : summary.active;

  return {
    pageCode,
    active: summary.active,
    awaitingYou: personalPending,
    pending,
    initial: summary.initial,
    final: summary.final,
    processing: summary.processing,
    href: preferredPayoutDisputeHref(hrefFocus),
    detail: payoutDisputeAttentionDetail({
      active: summary.active,
      awaitingYou: personalPending,
      pending,
      initial: summary.initial,
      final: summary.final,
      processing: summary.processing
    })
  };
}

/** Bell/nav badge: pending only (not completed / already-handled stages). */
export function payoutDisputeBadgeCount(attention: PayoutDisputeAttention) {
  return attention.pending;
}

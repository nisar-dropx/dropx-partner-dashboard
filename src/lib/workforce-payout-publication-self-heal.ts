import "server-only";

import type { AuthorizationContext } from "@/lib/authorization";
import { loadStablePayoutWorksheet } from "@/lib/stable-payout-worksheet";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePayoutDependencyHash } from "@/lib/workforce-payout-dependency";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";

export const MAX_WORKFORCE_PAYOUT_PUBLICATION_SELF_HEAL_ROWS = 10_000;

export type WorkforcePayoutPublicationSelfHealTarget = {
  workforceId: string;
  stationId: string;
};

export type WorkforcePayoutPublicationSelfHealResult = {
  dependencyHash: string;
  rows: Array<{
    workforceId: string;
    stationId: string;
    currentTargetAmount: number;
  }>;
  requested: number;
  enqueued: number;
  alreadyQueued: number;
  failed: number;
  current: number;
  missingPublication: number;
  mappingUnlocked: number;
};

type EnsureRefreshPayload = {
  requested?: unknown;
  enqueued?: unknown;
  already_queued?: unknown;
  failed?: unknown;
  current?: unknown;
  missing_publication?: unknown;
  mapping_unlocked?: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identity(workforceId: unknown, stationId: unknown) {
  return `${String(workforceId ?? "").trim().toLowerCase()}|${String(stationId ?? "").trim().toLowerCase()}`;
}

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function money(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("A selected payout has an invalid current amount.");
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function resultPayload(value: unknown): EnsureRefreshPayload {
  if (Array.isArray(value)) {
    const first = value[0];
    return first && typeof first === "object" ? first as EnsureRefreshPayload : {};
  }
  return value && typeof value === "object" ? value as EnsureRefreshPayload : {};
}

function normalizedTargets(targets: readonly WorkforcePayoutPublicationSelfHealTarget[]) {
  if (!targets.length) throw new Error("Select at least one payout publication to refresh.");
  if (targets.length > MAX_WORKFORCE_PAYOUT_PUBLICATION_SELF_HEAL_ROWS) {
    throw new Error(`Refresh at most ${MAX_WORKFORCE_PAYOUT_PUBLICATION_SELF_HEAL_ROWS.toLocaleString("en-US")} payout rows at a time.`);
  }
  const normalized = targets.map((target) => ({
    workforceId: String(target.workforceId ?? "").trim().toLowerCase(),
    stationId: String(target.stationId ?? "").trim().toLowerCase()
  }));
  if (normalized.some((target) => !UUID.test(target.workforceId) || !UUID.test(target.stationId))) {
    throw new Error("One or more payout publication refresh targets are invalid.");
  }
  if (new Set(normalized.map((target) => identity(target.workforceId, target.stationId))).size !== normalized.length) {
    throw new Error("Each payout publication refresh target must be unique.");
  }
  return normalized;
}

/**
 * Recalculates every requested payout under the caller's location scope before
 * asking the database to enqueue anything. Client-provided amounts are never
 * accepted, and an ambiguous or inaccessible identity fails the whole request.
 */
export async function ensureWorkforcePayoutPublicationRefreshJobs(input: {
  companyId: string;
  authorization: AuthorizationContext;
  actorUserId?: string;
  periodStart: string;
  periodEnd: string;
  targets: readonly WorkforcePayoutPublicationSelfHealTarget[];
}): Promise<WorkforcePayoutPublicationSelfHealResult> {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  if (input.authorization.companyId !== input.companyId) {
    throw new Error("The payout publication refresh company is outside your access scope.");
  }
  const targets = normalizedTargets(input.targets);
  if (!input.authorization.hasAllLocationAccess) {
    const allowed = new Set(input.authorization.locationScopeIds.map((id) => String(id).toLowerCase()));
    if (targets.some((target) => !allowed.has(target.stationId))) {
      throw new Error("One or more payout publication refresh targets are outside your permitted locations.");
    }
  }

  const workforceIds = [...new Set(targets.map((target) => target.workforceId))];
  const worksheet = await loadStablePayoutWorksheet({
    loadDependency: () => workforcePayoutDependencyHash(input.companyId, input.periodStart, input.periodEnd),
    loadRows: () => loadWorkforcePayoutRows(
      input.companyId,
      input.authorization,
      input.periodStart,
      input.periodEnd,
      { workforceIds }
    )
  });
  if (worksheet.error || !worksheet.dependencyHash) {
    throw new Error(worksheet.error || "Payout worksheet version is unavailable.");
  }

  const rowsByIdentity = new Map<string, typeof worksheet.rows>();
  for (const row of worksheet.rows) {
    if (!row.reviewSubjectId || !row.locationId) continue;
    const key = identity(row.reviewSubjectId, row.locationId);
    rowsByIdentity.set(key, [...(rowsByIdentity.get(key) ?? []), row]);
  }
  const authoritativeRows = targets.map((target) => {
    const matching = rowsByIdentity.get(identity(target.workforceId, target.stationId)) ?? [];
    if (matching.length !== 1) {
      throw new Error(matching.length
        ? "A selected payout has duplicate worksheet rows. Resolve the payout setup before refreshing its publication."
        : "A selected payout is missing or outside your permitted locations. Refresh the page and try again.");
    }
    const row = matching[0];
    if (!row.paymentDetailsAvailable) {
      throw new Error("A selected payout no longer has an authoritative payment setup. Refresh the page and correct its setup first.");
    }
    return {
      workforceId: target.workforceId,
      stationId: target.stationId,
      currentTargetAmount: money(row.netAmount)
    };
  });

  const ensured = await supabaseAdmin.rpc("workforce_ensure_payout_publication_refresh_jobs", {
    p_company_id: input.companyId,
    p_actor_user_id: input.actorUserId ?? input.authorization.userId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_dependency_hash: worksheet.dependencyHash,
    p_rows: authoritativeRows.map((row) => ({
      workforce_id: row.workforceId,
      station_id: row.stationId,
      current_target_amount: row.currentTargetAmount
    }))
  });
  if (ensured.error) throw new Error(ensured.error.message);
  const payload = resultPayload(ensured.data);
  return {
    dependencyHash: worksheet.dependencyHash,
    rows: authoritativeRows,
    requested: count(payload.requested),
    enqueued: count(payload.enqueued),
    alreadyQueued: count(payload.already_queued),
    failed: count(payload.failed),
    current: count(payload.current),
    missingPublication: count(payload.missing_publication),
    mappingUnlocked: count(payload.mapping_unlocked)
  };
}

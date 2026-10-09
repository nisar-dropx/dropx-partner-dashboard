import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadStablePayoutWorksheet } from "@/lib/stable-payout-worksheet";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePayoutDependencyHash } from "@/lib/workforce-payout-dependency";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import {
  buildWorkforcePayoutPublicationSnapshot,
  workforcePayoutPublicationSnapshotHash
} from "@/lib/workforce-payout-publication";
import {
  MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES,
  serializedJsonByteLength
} from "@/lib/workforce-payout-publication-limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MAPPING_LOCK_SELECTION = 50;
const MAX_MAPPING_LOCK_REQUEST_BYTES = 64 * 1024;

type RelockAuditRow = {
  id: string;
  company_id: string;
  period_start: string;
  period_end: string;
  unlock_ids: string[] | null;
  source_workforce_ids: string[] | null;
  affected_workforce_ids: string[] | null;
  publication_ids: string[] | null;
  change_summary: string;
};

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function validDate(value: string) {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function completeCalendarMonth(periodStart: string, periodEnd: string) {
  if (!validDate(periodStart) || !validDate(periodEnd) || !periodStart.endsWith("-01")) return false;
  const end = new Date(`${periodStart}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 10) === periodEnd;
}

function uniqueUuidList(value: unknown) {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => String(item ?? "").trim().toLowerCase());
  if (!ids.length
    || ids.length > MAX_MAPPING_LOCK_SELECTION
    || ids.some((id) => !UUID.test(id))
    || new Set(ids).size !== ids.length) {
    return null;
  }
  return ids;
}

function sameUuidSet(left: readonly unknown[], right: readonly unknown[]) {
  const normalize = (values: readonly unknown[]) => [...new Set(values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean))].sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function databaseErrorStatus(message: string) {
  return /already|approved|paid|cancelled|published|notification|refresh|changed|changing|updating|unavailable|outside|no provider mapping|operation id|relock|unlock|processing/i.test(message)
    ? 409
    : 400;
}

function resultRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function existingRelock(operationId: string) {
  const result = await supabaseAdmin!
    .from("workforce_payout_mapping_relocks")
    .select("id,company_id,period_start,period_end,unlock_ids,source_workforce_ids,affected_workforce_ids,publication_ids,change_summary")
    .eq("id", operationId)
    .maybeSingle();
  return { data: result.data as RelockAuditRow | null, error: result.error };
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return errorResponse("Invalid request origin.", 403);

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MAPPING_LOCK_REQUEST_BYTES) {
      return errorResponse("The mapping lock request is too large.", 413);
    }

    const authorization = await getAuthorization();
    if (!authorization) return errorResponse("Sign in to manage Workforce payout mapping locks.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (!hasPermission(authorization, pageCode, "edit")) {
      return errorResponse("Edit access to Workforce Payouts is required.", 403);
    }
    if (!authorization.hasAllLocationAccess) {
      return errorResponse("Mapping unlock and relock requires all-location access.", 403);
    }
    if (!supabaseAdmin) return errorResponse("Database configuration is unavailable.", 503);

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return errorResponse("Submit a valid mapping lock request.", 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return errorResponse("Submit a valid mapping lock request.", 400);
    }
    if (serializedJsonByteLength(body) > MAX_MAPPING_LOCK_REQUEST_BYTES) {
      return errorResponse("The mapping lock request is too large.", 413);
    }

    const companyId = requireCompanyId(authorization);
    const action = String(body.action ?? "").trim().toLowerCase();
    const periodStart = String(body.periodStart ?? "").trim();
    const periodEnd = String(body.periodEnd ?? "").trim();
    const operationId = String(body.operationId ?? "").trim().toLowerCase();
    if (action !== "unlock" && action !== "relock") {
      return errorResponse("Select mapping unlock or relock.", 400);
    }
    if (!completeCalendarMonth(periodStart, periodEnd)) {
      return errorResponse("Mapping unlock and relock is available only for one complete calendar month.", 400);
    }
    if (!UUID.test(operationId)) {
      return errorResponse("A valid operation ID is required.", 400);
    }

    const explanation = String(action === "unlock"
      ? body.reason ?? body.summary ?? ""
      : body.changeSummary ?? body.summary ?? "").trim();
    if (explanation.length < 10 || explanation.length > 500) {
      return errorResponse(
        action === "unlock"
          ? "Enter an unlock reason between 10 and 500 characters."
          : "Enter a relock change summary between 10 and 500 characters.",
        400
      );
    }

    if (action === "unlock") {
      const workforceIds = uniqueUuidList(body.workforceIds);
      if (!workforceIds) {
        return errorResponse(`Select between 1 and ${MAX_MAPPING_LOCK_SELECTION} unique Workforce IDs.`, 400);
      }
      const applied = await supabaseAdmin.rpc("workforce_unlock_payout_mappings", {
        p_company_id: companyId,
        p_actor_user_id: authorization.userId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_workforce_ids: workforceIds,
        p_operation_id: operationId,
        p_reason: explanation
      });
      if (applied.error) {
        return errorResponse(applied.error.message, databaseErrorStatus(applied.error.message));
      }
      return Response.json({ action: "unlocked", ...resultRecord(applied.data) }, { headers: noStore });
    }

    const unlockIds = uniqueUuidList(body.unlockIds);
    if (!unlockIds) {
      return errorResponse(`Select between 1 and ${MAX_MAPPING_LOCK_SELECTION} unique mapping unlocks.`, 400);
    }

    // Retrying a request after its first commit must remain idempotent. At that
    // point the selected unlock rows are no longer open, so replay the audit
    // result before resolving the current impacted identities.
    const replay = await existingRelock(operationId);
    if (replay.error) return errorResponse(replay.error.message, 500);
    if (replay.data) {
      if (replay.data.company_id !== companyId
        || replay.data.period_start !== periodStart
        || replay.data.period_end !== periodEnd
        || !sameUuidSet(replay.data.unlock_ids ?? [], unlockIds)
        || replay.data.change_summary.trim() !== explanation) {
        return errorResponse("The relock operation ID belongs to another request.", 409);
      }
      return Response.json({
        action: "relocked",
        replayed: true,
        relocked: replay.data.source_workforce_ids?.length ?? 0,
        affected: replay.data.affected_workforce_ids?.length ?? 0,
        published: replay.data.publication_ids?.length ?? 0,
        publication_ids: replay.data.publication_ids ?? [],
        relock_id: replay.data.id
      }, { headers: noStore });
    }

    const impacted = await supabaseAdmin.rpc("workforce_payout_mapping_unlock_impacted_ids", {
      p_company_id: companyId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_unlock_ids: unlockIds
    });
    if (impacted.error) {
      return errorResponse(impacted.error.message, databaseErrorStatus(impacted.error.message));
    }
    if (!Array.isArray(impacted.data)
      || impacted.data.some((id) => !UUID.test(String(id ?? "")))) {
      return errorResponse("The affected Workforce mapping scope is unavailable.", 409);
    }
    const impactedIds = [...new Set(impacted.data.map((id) => String(id).toLowerCase()))];
    if (!impactedIds.length) {
      return errorResponse("The selected mapping unlocks changed. Refresh the payout worksheet and try again.", 409);
    }

    const worksheet = await loadStablePayoutWorksheet({
      loadDependency: () => workforcePayoutDependencyHash(companyId, periodStart, periodEnd),
      loadRows: () => loadWorkforcePayoutRows(
        companyId,
        authorization,
        periodStart,
        periodEnd,
        { workforceIds: impactedIds }
      )
    });
    if (worksheet.error || !worksheet.dependencyHash) {
      return errorResponse(
        worksheet.error || "Payout inputs are still updating. Refresh and try again.",
        409
      );
    }

    const impactedSet = new Set(impactedIds);
    const itemKeys = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    for (const row of worksheet.rows) {
      const workforceId = String(row.reviewSubjectId ?? "").trim().toLowerCase();
      const stationId = String(row.locationId ?? "").trim().toLowerCase();
      if (!impactedSet.has(workforceId) || !UUID.test(stationId) || !row.paymentDetailsAvailable) continue;
      const key = `${workforceId}|${stationId}`;
      if (itemKeys.has(key)) {
        return errorResponse(
          "The recalculated worksheet contains duplicate Workforce/location rows. Refresh and correct the mapping before relocking.",
          409
        );
      }
      itemKeys.add(key);
      const snapshot = buildWorkforcePayoutPublicationSnapshot(
        row,
        periodStart,
        periodEnd,
        worksheet.dependencyHash
      );
      items.push({
        workforce_id: workforceId,
        station_id: stationId,
        snapshot,
        snapshot_hash: workforcePayoutPublicationSnapshotHash(snapshot)
      });
    }
    const relockArguments = {
      p_company_id: companyId,
      p_actor_user_id: authorization.userId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_unlock_ids: unlockIds,
      p_operation_id: operationId,
      p_change_summary: explanation,
      p_expected_dependency_hash: worksheet.dependencyHash,
      p_items: items
    };
    if (serializedJsonByteLength(relockArguments) > MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES) {
      return errorResponse("The recalculated payout publication is too large. Relock fewer Workforce IDs at a time.", 413);
    }

    const applied = await supabaseAdmin.rpc("workforce_relock_payout_mappings", relockArguments);
    if (applied.error) {
      return errorResponse(applied.error.message, databaseErrorStatus(applied.error.message));
    }
    return Response.json({ action: "relocked", ...resultRecord(applied.data) }, { headers: noStore });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to update Workforce payout mapping locks.", 500);
  }
}

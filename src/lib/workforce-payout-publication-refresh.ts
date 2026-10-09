import "server-only";

import type { AuthorizationContext } from "@/lib/authorization";
import { loadStablePayoutWorksheet } from "@/lib/stable-payout-worksheet";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePayoutDependencyHash } from "@/lib/workforce-payout-dependency";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import { workforcePayoutPublicationSnapshotHash } from "@/lib/workforce-payout-publication";
import {
  buildClearedInputOnlyWorkforcePayoutPublicationSnapshot,
  buildWorkforcePayoutPublicationSnapshot
} from "@/lib/workforce-payout-publication-snapshot";

type PublicationRefreshJob = {
  id: string;
  company_id: string;
  input_batch_id: string;
  workforce_id: string;
  station_id: string;
  period_start: string;
  period_end: string;
  base_publication_id: string;
  requested_by: string | null;
  claim_token: string;
  claim_attempts: number;
  max_attempts: number;
};

type LatestPublication = {
  id: string;
  workforce_id: string;
  station_id: string;
  revision: number;
  snapshot: unknown;
};

export type WorkforcePayoutPublicationRefreshWarning = {
  jobIds: string[];
  message: string;
};

export type WorkforcePayoutPublicationRefreshResult = {
  claimed: number;
  completed: number;
  published: number;
  publicationIds: string[];
  retrying: number;
  failed: number;
  staleClaims: number;
  warnings: WorkforcePayoutPublicationRefreshWarning[];
};

type WorkforcePayoutPublicationRefreshInput = {
  authorization?: AuthorizationContext;
  batchId?: string | null;
  companyId?: string | null;
  deadlineAtMs?: number;
  limit?: number;
};

const DEFAULT_RUNTIME_BUDGET_MS = 240_000;
const NEXT_CLAIM_RUNTIME_RESERVE_MS = 30_000;

function systemAuthorization(companyId: string): AuthorizationContext {
  return {
    companyCode: null,
    companyId,
    companyName: null,
    email: null,
    effectiveRoleIds: [],
    fullName: "Payout publication refresh",
    hasAllLocationAccess: true,
    isMasterCompany: false,
    isMasterOwner: false,
    locationScopeIds: [],
    permissions: {},
    roleCode: null,
    roleId: null,
    roleName: null,
    userId: "00000000-0000-0000-0000-000000000000"
  };
}

function jobGroupKey(job: PublicationRefreshJob, actorUserId: string) {
  return [job.company_id, job.period_start, job.period_end, actorUserId].join("|");
}

function rowIdentity(workforceId: unknown, stationId: unknown) {
  return `${String(workforceId ?? "").toLowerCase()}|${String(stationId ?? "").toLowerCase()}`;
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error || "Unable to refresh the published payout."))
    .slice(0, 2000);
}

async function failJobs(jobs: PublicationRefreshJob[], error: unknown) {
  if (!supabaseAdmin || !jobs.length) {
    return { error: null, retried: 0, failed: 0, stale: 0 };
  }
  const result = await supabaseAdmin.rpc("workforce_fail_payout_publication_refresh_jobs", {
    p_failures: jobs.map((job) => ({
      job_id: job.id,
      claim_token: job.claim_token,
      error: errorMessage(error)
    }))
  });
  const payload = result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : {};
  return {
    error: result.error?.message ?? null,
    retried: Number(payload.retried ?? 0),
    failed: Number(payload.failed ?? 0),
    stale: Number(payload.stale ?? 0)
  };
}

function recordFailure(
  result: WorkforcePayoutPublicationRefreshResult,
  jobs: PublicationRefreshJob[],
  error: unknown,
  failure: Awaited<ReturnType<typeof failJobs>>
) {
  result.retrying += failure.retried;
  result.failed += failure.failed;
  result.staleClaims += failure.stale;
  const suffix = failure.error
    ? ` Failure state could not be recorded: ${failure.error}`
    : failure.failed
      ? ` ${failure.failed} job${failure.failed === 1 ? " was" : "s were"} moved to failed/dead-letter state.`
      : failure.retried
        ? ` Retry scheduled with backoff for ${failure.retried} job${failure.retried === 1 ? "" : "s"}.`
        : failure.stale
          ? " The lease was already reclaimed by another worker."
          : "";
  result.warnings.push({
    jobIds: jobs.map((job) => job.id),
    message: `${errorMessage(error)}${suffix}`
  });
}

async function actorByJob(jobs: PublicationRefreshJob[]) {
  const actors = new Map(jobs.filter((job) => job.requested_by).map((job) => [job.id, String(job.requested_by)]));
  const missing = jobs.filter((job) => !job.requested_by);
  if (!missing.length || !supabaseAdmin) return actors;
  const publications = await supabaseAdmin
    .from("workforce_payout_publications")
    .select("id,published_by")
    .in("id", [...new Set(missing.map((job) => job.base_publication_id))]);
  if (publications.error) throw new Error(publications.error.message);
  const publisherByPublication = new Map((publications.data ?? []).map((row) => [String(row.id), String(row.published_by ?? "")]));
  missing.forEach((job) => {
    const publisher = publisherByPublication.get(job.base_publication_id);
    if (publisher) actors.set(job.id, publisher);
  });
  return actors;
}

async function surfaceCrashExpiredFailures(
  result: WorkforcePayoutPublicationRefreshResult,
  input: WorkforcePayoutPublicationRefreshInput,
  claimStartedAt: string,
  surfacedJobIds: Set<string>
) {
  if (!supabaseAdmin) return;
  let crashExpiredQuery = supabaseAdmin
    .from("workforce_payout_publication_refresh_jobs")
    .select("id,last_error")
    .eq("status", "failed")
    .gte("failed_at", claimStartedAt);
  if (input.companyId) crashExpiredQuery = crashExpiredQuery.eq("company_id", input.companyId);
  if (input.batchId) crashExpiredQuery = crashExpiredQuery.eq("input_batch_id", input.batchId);
  const crashExpired = await crashExpiredQuery;
  if (crashExpired.error) {
    result.warnings.push({
      jobIds: [],
      message: `Refresh claims were checked, but newly dead-lettered leases could not be listed: ${crashExpired.error.message}`
    });
  } else {
    const crashExpiredIds = [...new Set((crashExpired.data ?? [])
      .map((job) => String(job.id))
      .filter((jobId) => jobId && !surfacedJobIds.has(jobId)))];
    if (crashExpiredIds.length) {
      crashExpiredIds.forEach((jobId) => surfacedJobIds.add(jobId));
      result.failed += crashExpiredIds.length;
      result.warnings.push({
        jobIds: crashExpiredIds,
        message: `${crashExpiredIds.length} expired final-attempt refresh job${crashExpiredIds.length === 1 ? " was" : "s were"} moved to failed/dead-letter state before claiming new work. Replay the failed job after resolving the underlying issue.`
      });
    }
  }
}

async function processClaimedJobs(
  result: WorkforcePayoutPublicationRefreshResult,
  jobs: PublicationRefreshJob[],
  input: WorkforcePayoutPublicationRefreshInput
) {
  if (!supabaseAdmin) return;
  let actors: Map<string, string>;
  try {
    actors = await actorByJob(jobs);
  } catch (error) {
    recordFailure(result, jobs, error, await failJobs(jobs, error));
    return;
  }

  const groups = new Map<string, { actorUserId: string; jobs: PublicationRefreshJob[] }>();
  for (const job of jobs) {
    const actorUserId = input.authorization?.companyId === job.company_id
      ? input.authorization.userId
      : actors.get(job.id);
    if (!actorUserId) {
      const message = "The original payout publisher is unavailable; published payout refresh remains queued.";
      recordFailure(result, [job], message, await failJobs([job], message));
      continue;
    }
    const key = jobGroupKey(job, actorUserId);
    const group = groups.get(key) ?? { actorUserId, jobs: [] };
    group.jobs.push(job);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const first = group.jobs[0];
    let activeJobsForFailure = group.jobs;
    try {
      const authorization = input.authorization?.companyId === first.company_id
        ? input.authorization
        : systemAuthorization(first.company_id);
      const workforceIds = [...new Set(group.jobs.map((job) => job.workforce_id))];
      const worksheet = await loadStablePayoutWorksheet({
        loadDependency: () => workforcePayoutDependencyHash(first.company_id, first.period_start, first.period_end),
        loadRows: () => loadWorkforcePayoutRows(
          first.company_id,
          authorization,
          first.period_start,
          first.period_end,
          { workforceIds }
        )
      });
      if (worksheet.error || !worksheet.dependencyHash) {
        throw new Error(worksheet.error || "The payout worksheet version is unavailable.");
      }

      const latestPublications = await supabaseAdmin
        .from("workforce_payout_publications")
        .select("id,workforce_id,station_id,revision,snapshot")
        .eq("company_id", first.company_id)
        .eq("publication_kind", "worksheet")
        .eq("period_start", first.period_start)
        .eq("period_end", first.period_end)
        .in("workforce_id", workforceIds)
        .order("revision", { ascending: false })
        .order("published_at", { ascending: false })
        .order("id", { ascending: false });
      if (latestPublications.error) throw new Error(latestPublications.error.message);
      const latestByIdentity = new Map<string, LatestPublication>();
      for (const publication of (latestPublications.data ?? []) as LatestPublication[]) {
        const key = rowIdentity(publication.workforce_id, publication.station_id);
        if (!latestByIdentity.has(key)) latestByIdentity.set(key, publication);
      }

      const rowsByIdentity = new Map<string, typeof worksheet.rows>();
      for (const row of worksheet.rows) {
        if (!row.reviewSubjectId || !row.locationId) continue;
        const key = rowIdentity(row.reviewSubjectId, row.locationId);
        rowsByIdentity.set(key, [...(rowsByIdentity.get(key) ?? []), row]);
      }

      const revisionItems: Array<{
        job_id: string;
        workforce_id: string;
        station_id: string;
        snapshot: ReturnType<typeof buildWorkforcePayoutPublicationSnapshot>;
        snapshot_hash: string;
        claim_token: string;
      }> = [];
      const missingJobs: PublicationRefreshJob[] = [];
      for (const job of group.jobs) {
        const candidates = rowsByIdentity.get(rowIdentity(job.workforce_id, job.station_id)) ?? [];
        if (candidates.length > 1) {
          missingJobs.push(job);
          continue;
        }
        const snapshot = candidates.length === 1
          ? buildWorkforcePayoutPublicationSnapshot(
            candidates[0],
            job.period_start,
            job.period_end,
            worksheet.dependencyHash
          )
          : buildClearedInputOnlyWorkforcePayoutPublicationSnapshot(
            latestByIdentity.get(rowIdentity(job.workforce_id, job.station_id))?.snapshot,
            worksheet.dependencyHash
          );
        if (!snapshot) {
          missingJobs.push(job);
          continue;
        }
        revisionItems.push({
          job_id: job.id,
          claim_token: job.claim_token,
          workforce_id: job.workforce_id,
          station_id: job.station_id,
          snapshot,
          snapshot_hash: workforcePayoutPublicationSnapshotHash(snapshot)
        });
      }

      if (missingJobs.length) {
        const message = "The recalculated worksheet did not contain exactly one matching payout row, and the prior publication was not a safe input-only row to clear.";
        recordFailure(result, missingJobs, message, await failJobs(missingJobs, message));
      }
      if (!revisionItems.length) continue;
      const revisionJobIds = new Set(revisionItems.map((item) => item.job_id));
      activeJobsForFailure = group.jobs.filter((job) => revisionJobIds.has(job.id));

      const applied = await supabaseAdmin.rpc("workforce_apply_payout_publication_input_revisions", {
        p_company_id: first.company_id,
        p_period_start: first.period_start,
        p_period_end: first.period_end,
        p_expected_dependency_hash: worksheet.dependencyHash,
        p_actor_user_id: group.actorUserId,
        p_items: revisionItems
      });
      if (applied.error) throw new Error(applied.error.message);
      const payload = applied.data && typeof applied.data === "object" ? applied.data as Record<string, unknown> : {};
      result.completed += Number(payload.completed ?? revisionItems.length);
      result.published += Number(payload.published ?? revisionItems.length);
      if (Array.isArray(payload.publication_ids)) {
        result.publicationIds.push(...payload.publication_ids.map(String));
      }
    } catch (error) {
      recordFailure(result, activeJobsForFailure, error, await failJobs(activeJobsForFailure, error));
    }
  }
}

export async function refreshWorkforcePayoutPublicationJobs(
  input: WorkforcePayoutPublicationRefreshInput = {}
): Promise<WorkforcePayoutPublicationRefreshResult> {
  const result: WorkforcePayoutPublicationRefreshResult = {
    claimed: 0,
    completed: 0,
    published: 0,
    publicationIds: [],
    retrying: 0,
    failed: 0,
    staleClaims: 0,
    warnings: []
  };
  if (!supabaseAdmin) {
    result.warnings.push({ jobIds: [], message: "Database configuration is unavailable; published payout refresh remains queued." });
    return result;
  }

  const maxJobs = Math.max(1, Math.min(100, input.limit ?? 100));
  const deadlineAtMs = Number.isFinite(input.deadlineAtMs)
    ? Number(input.deadlineAtMs)
    : Date.now() + DEFAULT_RUNTIME_BUDGET_MS;
  const surfacedCrashExpiredJobIds = new Set<string>();
  let stoppedForDeadline = false;

  // A lease is also a retry attempt. Claim one immediately-processable unit at
  // a time so a hard function timeout cannot strand an untouched tail of jobs
  // in processing and eventually dead-letter work that was never started.
  while (result.claimed < maxJobs) {
    if (Date.now() + NEXT_CLAIM_RUNTIME_RESERVE_MS >= deadlineAtMs) {
      stoppedForDeadline = true;
      break;
    }
    const claimStartedAt = new Date().toISOString();
    const claimed = await supabaseAdmin.rpc("workforce_claim_payout_publication_refresh_jobs", {
      p_limit: 1,
      p_company_id: input.companyId ?? null,
      p_batch_id: input.batchId ?? null
    });
    if (claimed.error) {
      result.warnings.push({ jobIds: [], message: claimed.error.message });
      break;
    }
    await surfaceCrashExpiredFailures(
      result,
      input,
      claimStartedAt,
      surfacedCrashExpiredJobIds
    );
    const jobs = (claimed.data ?? []) as PublicationRefreshJob[];
    if (!jobs.length) break;
    result.claimed += jobs.length;
    await processClaimedJobs(result, jobs, input);
  }

  if (stoppedForDeadline) {
    result.warnings.push({
      jobIds: [],
      message: "The refresh runtime reserve was reached; remaining published payout updates stay queued for the next worker."
    });
  }
  return result;
}

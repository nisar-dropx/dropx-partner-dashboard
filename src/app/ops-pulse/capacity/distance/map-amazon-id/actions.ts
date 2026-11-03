"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import {
  dayBefore,
  eachIsoDate,
  isValidAmazonTransporterId,
  isValidIsoDate,
  normalizeAmazonTransporterId,
  dateRangesOverlap,
  type AmazonTransporterAssignment,
} from "@/lib/ops-pulse/amazon-transporter-assignments";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : "";
}

function mapRedirect(params: {
  workforce: string;
  station: string;
  from: string;
  to: string;
  error?: string;
  notice?: string;
}): never {
  const qs = new URLSearchParams({
    workforce: params.workforce,
    station: params.station,
    from: params.from,
    to: params.to,
  });
  if (params.error) qs.set("error", params.error);
  if (params.notice) qs.set("notice", params.notice);
  redirect(`/ops-pulse/capacity/distance/map-amazon-id?${qs}`);
}

async function assertStationInScope(auth: Awaited<ReturnType<typeof requirePagePermission>>, stationId: string) {
  const companyId = requireCompanyId(auth);
  const scope = await loadCodLocations(companyId, auth.locationScopeIds, auth.hasAllLocationAccess);
  if (scope.error) throw new Error("Station access could not be verified. Please retry.");
  const station = scope.locations.find((s) => s.id === stationId && isAmazonEdspXptLocation(s));
  if (!station) throw new Error("Station not found.");
  return { companyId, station };
}

function isNextRedirect(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT")
  );
}

/** Worker processes at most 5 dates per /payable-distance/station call. */
const SYNC_DAYS_PER_REQUEST = 5;
/** Keep total auto-sync inside typical server-action budgets. */
const SYNC_TIME_BUDGET_MS = 100_000;

async function syncStationDays(stationId: string, from: string, to: string) {
  const today = todayKolkata();
  const minSync = new Date(Date.parse(today + "T00:00:00Z") - 35 * 86400000)
    .toISOString()
    .slice(0, 10);
  const maxSync = new Date(Date.parse(today + "T00:00:00Z") - 86400000)
    .toISOString()
    .slice(0, 10);
  const days = eachIsoDate(from, to).filter((d) => d >= minSync && d <= maxSync);
  const workerUrl = (
    process.env.AMAZON_SYNC_WORKER_URL ||
    "https://dropx-amazon-sync.withered-voice-1c40.workers.dev"
  ).replace(/\/$/, "");
  const adminKey = (
    process.env.AMAZON_SYNC_ADMIN_KEY ||
    process.env.CASH_RECON_ADMIN_KEY ||
    ""
  )
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!days.length) {
    return { synced: 0, failed: 0, attempted: 0, remaining: 0, error: null as string | null };
  }
  if (!adminKey) {
    return {
      synced: 0,
      failed: 0,
      attempted: 0,
      remaining: days.length,
      error: "Amazon sync is not configured (AMAZON_SYNC_ADMIN_KEY).",
    };
  }

  const chunks: string[][] = [];
  for (let i = 0; i < days.length; i += SYNC_DAYS_PER_REQUEST) {
    chunks.push(days.slice(i, i + SYNC_DAYS_PER_REQUEST));
  }

  let synced = 0;
  let failed = 0;
  let attempted = 0;
  let error: string | null = null;
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;

  for (const chunk of chunks) {
    const left = deadline - Date.now();
    if (left < 5_000) break;
    attempted += chunk.length;
    try {
      const res = await fetch(`${workerUrl}/payable-distance/station`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ stationId, dates: chunk }),
        signal: AbortSignal.timeout(Math.min(110_000, left)),
        cache: "no-store",
      });
      if (res.status === 401) {
        failed += chunk.length;
        error = "Amazon sync rejected the admin key.";
        break;
      }
      if (!res.ok) {
        failed += chunk.length;
        error = error || `Amazon sync failed (HTTP ${res.status}).`;
        continue;
      }
      const results = (await res.json().catch(() => null)) as Array<{ outcome?: string }> | null;
      if (!Array.isArray(results)) {
        failed += chunk.length;
        error = error || "Amazon sync returned an unexpected response.";
        continue;
      }
      for (const row of results) {
        if (row?.outcome === "done") synced += 1;
        else failed += 1;
      }
      // Worker may truncate to 5; count any unreturned dates as failed.
      if (results.length < chunk.length) failed += chunk.length - results.length;
    } catch {
      failed += chunk.length;
      error = error || "Amazon sync timed out. Mapping was saved — retry sync from Distance & Fuel.";
    }
  }

  return {
    synced,
    failed,
    attempted,
    remaining: Math.max(0, days.length - attempted),
    error,
  };
}

function syncNotice(transporterId: string, from: string, to: string, sync: Awaited<ReturnType<typeof syncStationDays>>) {
  const base = `Amazon driver ID ${transporterId} saved for ${from} to ${to}.`;
  if (sync.attempted === 0 && sync.remaining === 0) {
    return `${base} Sync those days from Distance & Fuel if they are older than 35 days.`;
  }
  if (sync.attempted === 0 && sync.error) {
    return `${base} ${sync.error}`;
  }
  if (sync.attempted === 0) {
    return `${base} Auto re-sync did not run; use Distance & Fuel sync for these days.`;
  }
  const parts = [`${base} Re-synced ${sync.synced}/${sync.attempted} day(s)`];
  if (sync.failed) parts.push(`${sync.failed} failed`);
  if (sync.remaining) parts.push(`${sync.remaining} left — sync the rest from Distance & Fuel`);
  if (sync.error && sync.synced === 0) parts.push(sync.error);
  return `${parts.join(". ")}.`;
}

export async function saveAmazonTransporterAssignment(form: FormData) {
  const auth = await requirePagePermission("capacity_associates", "access");
  const workforceId = clean(form.get("workforce_id"));
  const stationId = clean(form.get("station_id"));
  const from = clean(form.get("effective_from"));
  const to = clean(form.get("effective_to"));
  const transporterId = normalizeAmazonTransporterId(clean(form.get("transporter_id")));
  const changeId = clean(form.get("assignment_id"));

  const back = { workforce: workforceId, station: stationId, from, to };

  try {
    if (auth.readOnly) throw new Error("Preview mode is read-only.");
    if (!supabaseAdmin) throw new Error("Database is unavailable.");
    if (!/^[0-9a-f-]{36}$/i.test(workforceId)) throw new Error("Associate is missing.");
    if (!/^[0-9a-f-]{36}$/i.test(stationId)) throw new Error("Station is missing.");
    if (!isValidIsoDate(from) || !isValidIsoDate(to)) throw new Error("Choose valid From and To dates.");
    if (from > to) throw new Error("From date cannot be after To date.");
    if (!isValidAmazonTransporterId(transporterId)) {
      throw new Error("Enter a valid Amazon driver ID (starts with A…).");
    }

    const { companyId } = await assertStationInScope(auth, stationId);

    const { data: person, error: personError } = await supabaseAdmin
      .from("workforce")
      .select("id")
      .eq("company_id", companyId)
      .eq("id", workforceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (personError || !person) throw new Error("Associate not found.");

    // Load all same-station rows that could collide (broader than the new range
    // when editing, so shrinking/moving an existing assignment is safe).
    const { data: stationRows, error: stationLoadError } = await supabaseAdmin
      .from("workforce_amazon_transporter_assignments")
      .select("id,company_id,station_id,workforce_id,transporter_id,effective_from,effective_to,created_at,updated_at")
      .eq("company_id", companyId)
      .eq("station_id", stationId);
    if (stationLoadError) throw new Error(stationLoadError.message || "Unable to load existing Amazon ID assignments.");
    const existing = (stationRows || []) as AmazonTransporterAssignment[];

    const driverClash = existing.find(
      (row) =>
        row.workforce_id !== workforceId &&
        row.transporter_id === transporterId &&
        dateRangesOverlap(row.effective_from, row.effective_to, from, to) &&
        row.id !== changeId,
    );
    if (driverClash) {
      throw new Error(
        `Amazon driver ID ${transporterId} is already mapped to another associate for overlapping dates.`,
      );
    }

    // Also block IDs already claimed via portal link or settled distance for another associate.
    // Mapping the same A… on a shared station-day marks BOTH people as identity_conflict.
    const { data: portalClaim } = await supabaseAdmin
      .from("workforce_amazon_portal_links")
      .select("workforce_id")
      .eq("company_id", companyId)
      .eq("transporter_id", transporterId)
      .neq("workforce_id", workforceId)
      .limit(1);
    if (portalClaim?.length) {
      throw new Error(
        `Amazon driver ID ${transporterId} is already linked to another associate in the portal.`,
      );
    }
    const { data: distanceClaim } = await supabaseAdmin
      .from("workforce_route_distances")
      .select("workforce_id,work_date")
      .eq("company_id", companyId)
      .eq("station_id", stationId)
      .eq("transporter_id", transporterId)
      .neq("workforce_id", workforceId)
      .gte("work_date", from)
      .lte("work_date", to)
      .limit(1);
    if (distanceClaim?.length) {
      throw new Error(
        `Amazon driver ID ${transporterId} is already used by another associate on ${distanceClaim[0].work_date} at this station.`,
      );
    }

    const dayAfter = (iso: string) =>
      new Date(Date.parse(iso + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);

    // Replace overlapping assignments for this associate+station.
    // Keep head/tail segments when an edit shrinks or moves the active range.
    const remnants: Array<{ transporter_id: string; effective_from: string; effective_to: string | null }> = [];
    const queueHead = (row: AmazonTransporterAssignment) => {
      if (row.effective_from < from) {
        const headTo = dayBefore(from);
        if (headTo >= row.effective_from) {
          remnants.push({
            transporter_id: row.transporter_id,
            effective_from: row.effective_from,
            effective_to: headTo,
          });
        }
      }
    };
    const queueTail = (row: AmazonTransporterAssignment) => {
      const oldEnd = row.effective_to ?? "9999-12-31";
      if (row.effective_to == null || row.effective_to > to) {
        const tailFrom = dayAfter(to);
        if (tailFrom <= oldEnd) {
          remnants.push({
            transporter_id: row.transporter_id,
            effective_from: tailFrom,
            effective_to: row.effective_to,
          });
        }
      }
    };

    for (const row of existing) {
      if (row.workforce_id !== workforceId) continue;
      if (changeId && row.id === changeId) {
        // Row will be rewritten; preserve any uncovered head/tail as new rows.
        queueHead(row);
        queueTail(row);
        continue;
      }
      if (!dateRangesOverlap(row.effective_from, row.effective_to, from, to)) continue;
      queueTail(row);

      if (row.effective_from >= from) {
        const { error } = await supabaseAdmin
          .from("workforce_amazon_transporter_assignments")
          .delete()
          .eq("id", row.id)
          .eq("company_id", companyId);
        if (error) throw new Error(error.message || "Unable to replace prior assignment.");
        continue;
      }

      const closedTo = dayBefore(from);
      if (closedTo < row.effective_from) {
        const { error } = await supabaseAdmin
          .from("workforce_amazon_transporter_assignments")
          .delete()
          .eq("id", row.id)
          .eq("company_id", companyId);
        if (error) throw new Error(error.message || "Unable to replace prior assignment.");
        continue;
      }

      // Head stays on this row via effective_to close; tail already queued.
      const { error } = await supabaseAdmin
        .from("workforce_amazon_transporter_assignments")
        .update({ effective_to: closedTo, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("company_id", companyId);
      if (error) throw new Error(error.message || "Unable to close prior assignment.");
    }

    if (changeId) {
      const { data: updated, error } = await supabaseAdmin
        .from("workforce_amazon_transporter_assignments")
        .update({
          transporter_id: transporterId,
          effective_from: from,
          effective_to: to,
          updated_at: new Date().toISOString(),
        })
        .eq("id", changeId)
        .eq("company_id", companyId)
        .eq("workforce_id", workforceId)
        .eq("station_id", stationId)
        .select("id");
      if (error) throw new Error(error.message || "Unable to update Amazon ID assignment.");
      if (!updated?.length) throw new Error("Assignment not found. Refresh and try again.");
    } else {
      const { error } = await supabaseAdmin.from("workforce_amazon_transporter_assignments").insert({
        company_id: companyId,
        station_id: stationId,
        workforce_id: workforceId,
        transporter_id: transporterId,
        effective_from: from,
        effective_to: to,
        created_by: auth.userId,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message || "Unable to save Amazon ID assignment.");
    }

    const seenRemnant = new Set<string>();
    for (const rem of remnants) {
      const key = `${rem.transporter_id}|${rem.effective_from}|${rem.effective_to ?? ""}`;
      if (seenRemnant.has(key)) continue;
      seenRemnant.add(key);
      if (dateRangesOverlap(rem.effective_from, rem.effective_to, from, to)) continue;
      const { error } = await supabaseAdmin.from("workforce_amazon_transporter_assignments").insert({
        company_id: companyId,
        station_id: stationId,
        workforce_id: workforceId,
        transporter_id: rem.transporter_id,
        effective_from: rem.effective_from,
        effective_to: rem.effective_to,
        created_by: auth.userId,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message || "Unable to keep the prior mapping segment.");
    }

    const sync = await syncStationDays(stationId, from, to);
    revalidateTag("ops-capacity-distance");
    revalidatePath("/ops-pulse/capacity/distance");
    revalidatePath("/ops-pulse/capacity/distance/identity");
    revalidatePath("/ops-pulse/capacity/distance/map-amazon-id");

    mapRedirect({
      ...back,
      notice: syncNotice(transporterId, from, to, sync),
    });
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    mapRedirect({
      ...back,
      error: e instanceof Error ? e.message : "Unable to save Amazon ID assignment.",
    });
  }
}

export async function endAmazonTransporterAssignment(form: FormData) {
  const auth = await requirePagePermission("capacity_associates", "access");
  const workforceId = clean(form.get("workforce_id"));
  const stationId = clean(form.get("station_id"));
  const from = clean(form.get("from"));
  const to = clean(form.get("to"));
  const assignmentId = clean(form.get("assignment_id"));
  const endOn = clean(form.get("end_on")) || todayKolkata();
  const back = { workforce: workforceId, station: stationId, from, to };

  try {
    if (auth.readOnly) throw new Error("Preview mode is read-only.");
    if (!supabaseAdmin) throw new Error("Database is unavailable.");
    if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) throw new Error("Assignment is missing.");
    if (!isValidIsoDate(endOn)) throw new Error("Choose a valid end date.");
    const { companyId } = await assertStationInScope(auth, stationId);

    const { data: row, error: loadError } = await supabaseAdmin
      .from("workforce_amazon_transporter_assignments")
      .select("id,effective_from,effective_to")
      .eq("id", assignmentId)
      .eq("company_id", companyId)
      .eq("station_id", stationId)
      .eq("workforce_id", workforceId)
      .maybeSingle();
    if (loadError || !row) throw new Error("Assignment not found.");
    if (endOn < row.effective_from) throw new Error("End date cannot be before the assignment start.");

    const { data: ended, error } = await supabaseAdmin
      .from("workforce_amazon_transporter_assignments")
      .update({ effective_to: endOn, updated_at: new Date().toISOString() })
      .eq("id", assignmentId)
      .eq("company_id", companyId)
      .eq("station_id", stationId)
      .eq("workforce_id", workforceId)
      .select("effective_from,effective_to");
    if (error) throw new Error(error.message || "Unable to end assignment.");
    if (!ended?.length) throw new Error("Assignment not found. Refresh and try again.");

    const syncFrom = ended[0].effective_from;
    const syncTo = ended[0].effective_to || endOn;
    const sync = await syncStationDays(stationId, syncFrom, syncTo);

    revalidateTag("ops-capacity-distance");
    revalidatePath("/ops-pulse/capacity/distance");
    revalidatePath("/ops-pulse/capacity/distance/identity");
    revalidatePath("/ops-pulse/capacity/distance/map-amazon-id");
    mapRedirect({
      ...back,
      notice:
        sync.synced > 0
          ? `Assignment ended on ${endOn}. Re-synced ${sync.synced}/${sync.attempted} day(s).`
          : `Assignment ended on ${endOn}.${sync.error ? ` ${sync.error}` : ""}`,
    });
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    mapRedirect({
      ...back,
      error: e instanceof Error ? e.message : "Unable to end assignment.",
    });
  }
}

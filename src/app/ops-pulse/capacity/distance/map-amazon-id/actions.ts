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
  if (!adminKey) return { synced: 0, attempted: days.length };
  let ok = 0;
  for (const date of days.slice(0, 31)) {
    try {
      const res = await fetch(`${workerUrl}/payable-distance/station`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ stationId, dates: [date] }),
        signal: AbortSignal.timeout(110000),
        cache: "no-store",
      });
      if (res.ok) ok += 1;
    } catch {
      /* keep going */
    }
  }
  return { synced: ok, attempted: Math.min(days.length, 31) };
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
      notice:
        sync.attempted === 0
          ? `Amazon driver ID ${transporterId} saved for ${from} to ${to}. Sync those days from Distance & Fuel if they are older than 35 days.`
          : `Amazon driver ID ${transporterId} saved. Re-synced ${sync.synced}/${sync.attempted} day(s).`,
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

    const { error } = await supabaseAdmin
      .from("workforce_amazon_transporter_assignments")
      .update({ effective_to: endOn, updated_at: new Date().toISOString() })
      .eq("id", assignmentId)
      .eq("company_id", companyId)
      .eq("station_id", stationId)
      .eq("workforce_id", workforceId);
    if (error) throw new Error(error.message || "Unable to end assignment.");

    revalidateTag("ops-capacity-distance");
    revalidatePath("/ops-pulse/capacity/distance/map-amazon-id");
    mapRedirect({ ...back, notice: `Assignment ended on ${endOn}.` });
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    mapRedirect({
      ...back,
      error: e instanceof Error ? e.message : "Unable to end assignment.",
    });
  }
}

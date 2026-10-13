import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  fetchCiaNetwork,
  isCashReconWorkerConfigured,
} from "@/lib/ops-pulse/cash-recon-worker";
import {
  fetchEddPerformanceStation,
  fetchEddStation,
  isEddWorkerConfigured,
} from "@/lib/ops-pulse/edd-worker";
import { loadCodPendingReport } from "@/lib/ops-pulse/cod-pending-data";
import { addAuditDays, auditDay } from "./station-audit-planning";

/**
 * What an auditor should know about a station before the visit, read from the
 * figures Delivery Performance and COD already keep. Each part is null when its
 * source has nothing for this station or did not answer in time.
 */
export type AuditStationSnapshot = {
  stationCode: string;
  /** Cash in Associate: cash still with executives and how many have not reconciled. */
  cia: {
    total: number;
    pendingLiability: number;
    pendingExecutives: number;
    asOf: string | null;
  } | null;
  /** Delivery Performance › Ageing: shipments still at the station by promised date. */
  ageing: {
    total: number;
    overdue: number;
    dueToday: number;
    asOf: string | null;
  } | null;
  /** Delivery Performance › Performance: sent out today and not yet delivered or returned. */
  held: { held: number; assigned: number; asOf: string | null } | null;
  /** COD deposit slip for today and yesterday. */
  slips:
    | {
        date: string;
        status: string;
        uploaded: boolean;
        /** Still owed after that day's submission deadline has passed. */
        overdue: boolean;
      }[]
    | null;
};

/** A slow or failing source must never hold up the audit window. */
async function within<T>(work: Promise<T>, ms = 8000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadAuditStationSnapshot(
  companyId: string,
  station: { id: string; station_code: string },
): Promise<AuditStationSnapshot> {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const db = supabaseAdmin;
  // Delivery Performance and CIA know a station by its portal code when one is set.
  const setting = await db
    .from("cod_station_settings")
    .select("portal_station_code")
    .eq("company_id", companyId)
    .eq("location_id", station.id)
    .maybeSingle();
  const stationCode = String(
    setting.data?.portal_station_code || station.station_code || "",
  )
    .trim()
    .toUpperCase();
  const today = auditDay();
  const days = [today, addAuditDays(today, -1)];
  const [ageing, performance, cia, slips] = await Promise.all([
    isEddWorkerConfigured() && stationCode
      ? within(fetchEddStation({ stationCode, timeoutMs: 8000 }))
      : null,
    isEddWorkerConfigured() && stationCode
      ? within(fetchEddPerformanceStation({ stationCode, timeoutMs: 8000 }))
      : null,
    isCashReconWorkerConfigured() && stationCode
      ? within(fetchCiaNetwork())
      : null,
    within(
      Promise.all(
        days.map((date) =>
          loadCodPendingReport(db, companyId, [station.id], false, date),
        ),
      ),
    ),
  ]);
  const ciaRow = cia?.stations.find(
    (row) => row.stationCode.toUpperCase() === stationCode && row.status === "ok",
  );
  const slipRows = slips
    ? slips.flatMap((rows, index) =>
        rows
          .filter((row) => row.station.id === station.id)
          .map((row) => ({
            date: days[index],
            status: row.status,
            uploaded: row.slipUploaded,
            overdue: row.overdue,
          })),
      )
    : null;
  return {
    stationCode,
    cia: ciaRow
      ? {
          total: ciaRow.ciaTotal,
          pendingLiability: ciaRow.pendingLiability,
          pendingExecutives: ciaRow.pendingDriverCount,
          asOf: ciaRow.fetchedAt,
        }
      : null,
    ageing:
      ageing?.status === "ok"
        ? {
            total: ageing.payload.totalCount,
            overdue: ageing.payload.buckets.overdue,
            dueToday: ageing.payload.buckets.dueToday,
            asOf: ageing.payload.fetchedAt,
          }
        : null,
    held:
      performance?.status === "ok"
        ? {
            held: performance.payload.held,
            assigned: performance.payload.assigned,
            asOf: performance.payload.fetchedAt,
          }
        : null,
    // A station outside the COD programme has no slip rows at all.
    slips: slipRows && slipRows.length ? slipRows : null,
  };
}

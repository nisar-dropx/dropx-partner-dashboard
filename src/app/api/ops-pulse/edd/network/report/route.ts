import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddNetwork, type EddBucketKey } from "@/lib/ops-pulse/edd-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BUCKET_KEYS: EddBucketKey[] = ["overdue", "dueToday", "dueTomorrow", "future", "unknown"];

/** Excel download of the network-wide Ageing overview — one row per station. */
export async function GET() {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const payload = await fetchEddNetwork();
    const rows = payload.stations.map((station) => {
      const row: Record<string, unknown> = {
        Station: station.stationCode,
        "Has Snapshot": station.hasSnapshot ? "Yes" : "No",
        "Fetched At": station.fetchedAt ?? "",
        "Total Live": station.totalCount
      };
      for (const bucket of BUCKET_KEYS) {
        row[bucket === "overdue" ? "Overdue" : bucket === "dueToday" ? "Due today" : bucket === "dueTomorrow" ? "Due tomorrow" : bucket === "future" ? "Future" : "Unknown"] = station.buckets[bucket] ?? 0;
      }
      return row;
    });

    return workbookResponse([{ name: "Network overview", rows }], `ageing-network-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Ageing network report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

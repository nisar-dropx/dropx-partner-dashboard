import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchLoadFlashTracking } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations } from "@/lib/ops-pulse/load-flash-access";
import { CRETURN_PICKED_UP_BUCKET } from "@/lib/ops-pulse/station-board";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Kind = "edd" | "creturn" | "dsr" | "zero" | "ageing";

/** Board-only TID buckets (must match amazon-edd-worker BOARD_TID_BUCKET). */
const BOARD = {
  EDD: "BoardEDD",
  CRETURN: "BoardCReturn",
  DELIVERED: "BoardDelivered",
  FAILED: "BoardFailed",
  REJECTED: "BoardRejected",
  OOR: "BoardOOR",
  AGEING: "BoardAgeing",
} as const;

const KIND_BUCKETS: Record<Kind, string[]> = {
  edd: [BOARD.EDD, "EDD"],
  creturn: [BOARD.CRETURN, "Pickup"],
  ageing: [BOARD.AGEING],
  dsr: [BOARD.DELIVERED, BOARD.FAILED, BOARD.REJECTED, BOARD.OOR, "Failed", "Rejected"],
  zero: [BOARD.DELIVERED, BOARD.FAILED, BOARD.REJECTED, BOARD.OOR, "Failed", "Rejected"],
};

/**
 * Station-wise tracking IDs for Station board drill-down.
 * Always board Refresh buckets — never Ops Live Inducted/Delivered/OOR census.
 */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const params = new URL(request.url).searchParams;
    const station = String(params.get("station") ?? "").trim().toUpperCase();
    const date = String(params.get("date") ?? "").trim();
    const kind = String(params.get("kind") ?? "creturn").trim().toLowerCase() as Kind;
    if (!station) return NextResponse.json({ error: "Choose a station." }, { status: 400 });
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Choose a valid date." }, { status: 400 });
    }
    if (!["edd", "creturn", "dsr", "zero", "ageing"].includes(kind)) {
      return NextResponse.json({ error: "Unknown report kind." }, { status: 400 });
    }
    const viewer = await loadFlashViewerStations();
    if (!viewer.some((row) => row.code === station)) {
      return NextResponse.json({ error: "Station access required." }, { status: 403 });
    }

    const flash = (
      await fetchLoadFlashTracking(date || undefined, [station], { buckets: KIND_BUCKETS[kind] })
    ).filter((row) => row.stationCode === station);

    if (kind === "edd") {
      const preferBoard = flash.some((row) => row.bucket === BOARD.EDD);
      const rows = flash
        .filter((row) => (preferBoard ? row.bucket === BOARD.EDD : row.bucket === "EDD"))
        .map((row) => ({
          trackingId: row.trackingId,
          status: row.state || "Inducted",
          edd: row.edd || "",
          driverId: row.driverId,
          driverName: row.driverName,
        }))
        .filter((row) => row.trackingId);
      return NextResponse.json({ station, kind, rows }, { headers: { "Cache-Control": "no-store" } });
    }

    if (kind === "creturn") {
      // Prefer BoardCReturn when present — Ops Live also stores Pickup for the same TIDs.
      const preferBoard = flash.some((row) => row.bucket === BOARD.CRETURN);
      const rows = flash
        .filter((row) => (preferBoard ? row.bucket === BOARD.CRETURN : row.bucket === "Pickup"))
        .map((row) => {
          const raw = String(row.state || "").trim().toUpperCase();
          const status = CRETURN_PICKED_UP_BUCKET.has(raw) ? "PICKUP_DONE" : raw || "UNKNOWN";
          return {
            trackingId: row.trackingId,
            status,
            edd: row.edd || "",
            driverId: row.driverId,
            driverName: row.driverName,
          };
        })
        .filter((row) => row.trackingId);
      return NextResponse.json({ station, kind, rows }, { headers: { "Cache-Control": "no-store" } });
    }

    if (kind === "ageing") {
      const rows = flash
        .filter((row) => row.bucket === BOARD.AGEING)
        .map((row) => ({
          trackingId: row.trackingId,
          status: row.state || "",
          edd: row.edd || "",
          driverId: row.driverId,
          driverName: row.driverName,
        }))
        .filter((row) => row.trackingId);
      return NextResponse.json({ station, kind, rows }, { headers: { "Cache-Control": "no-store" } });
    }

    const dsrBuckets = new Set([
      BOARD.DELIVERED,
      BOARD.FAILED,
      BOARD.REJECTED,
      BOARD.OOR,
      "Failed",
      "Rejected",
    ]);
    let rows = flash
      .filter((row) => dsrBuckets.has(row.bucket))
      .map((row) => ({
        trackingId: row.trackingId,
        status:
          row.bucket === BOARD.DELIVERED ? "Delivered"
            : row.bucket === BOARD.OOR ? "OOR"
              : row.bucket === BOARD.FAILED || row.bucket === "Failed" ? "Failed"
                : row.bucket === BOARD.REJECTED || row.bucket === "Rejected" ? "Rejected"
                  : row.bucket,
        edd: row.edd || "",
        driverId: row.driverId,
        driverName: row.driverName,
      }))
      .filter((row) => row.trackingId);

    if (kind === "zero") {
      const deliveredByDriver = new Map<string, number>();
      for (const row of rows) {
        if (row.status !== "Delivered") continue;
        const id = row.driverId || "(no DA)";
        deliveredByDriver.set(id, (deliveredByDriver.get(id) ?? 0) + 1);
      }
      rows = rows.filter((row) => (deliveredByDriver.get(row.driverId || "(no DA)") ?? 0) === 0 && row.status !== "Delivered");
    }

    return NextResponse.json({ station, kind, rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load tracking IDs.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

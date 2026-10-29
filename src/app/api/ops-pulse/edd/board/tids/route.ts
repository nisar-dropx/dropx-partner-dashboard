import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddStation, fetchLoadFlashTracking } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations } from "@/lib/ops-pulse/load-flash-access";
import { CRETURN_PICKED_UP_BUCKET } from "@/lib/ops-pulse/station-board";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Kind = "edd" | "creturn" | "dsr" | "zero";

/**
 * Station-wise tracking IDs for Station board drill-down.
 * EDD → ageing packages; C-Return / DSR / Zero → Ops Live flash package rows.
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
    if (!["edd", "creturn", "dsr", "zero"].includes(kind)) {
      return NextResponse.json({ error: "Unknown report kind." }, { status: 400 });
    }
    const viewer = await loadFlashViewerStations();
    if (!viewer.some((row) => row.code === station)) {
      return NextResponse.json({ error: "Station access required." }, { status: 403 });
    }

    if (kind === "edd") {
      const result = await fetchEddStation({ stationCode: station });
      if (result.status !== "ok") {
        return NextResponse.json({ station, kind, rows: [] }, { headers: { "Cache-Control": "no-store" } });
      }
      const rows = result.payload.packages.map((pkg) => ({
        trackingId: pkg.trackingId,
        status: pkg.state || "",
        edd: pkg.ead || "",
        driverId: "",
        driverName: "",
      })).filter((row) => row.trackingId);
      return NextResponse.json({ station, kind, rows }, { headers: { "Cache-Control": "no-store" } });
    }

    const flash = (await fetchLoadFlashTracking(date || undefined, [station])).filter((row) => row.stationCode === station);
    if (kind === "creturn") {
      const rows = flash
        .filter((row) => row.bucket === "Pickup")
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
        });
      return NextResponse.json({ station, kind, rows }, { headers: { "Cache-Control": "no-store" } });
    }

    const deliveryBuckets = new Set(["Delivered", "Out on road", "Failed", "Rejected"]);
    let rows = flash
      .filter((row) => deliveryBuckets.has(row.bucket))
      .map((row) => ({
        trackingId: row.trackingId,
        status:
          row.bucket === "Delivered" ? "Delivered"
            : row.bucket === "Out on road" ? "OOR"
              : row.bucket,
        edd: row.edd || "",
        driverId: row.driverId,
        driverName: row.driverName,
      }));
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

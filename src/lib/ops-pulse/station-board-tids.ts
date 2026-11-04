import { CRETURN_PICKED_UP_BUCKET } from "./station-board.ts";
import { isPremiumDot, isStandardDot } from "./ship-option-dot.ts";

/** Board-only TID buckets (must match amazon-edd-worker BOARD_TID_BUCKET). */
export const BOARD_TID = {
  EDD: "BoardEDD",
  PHYSICAL: "BoardPhysical",
  PENDING_TODAY: "BoardPendingToday",
  CRETURN: "BoardCReturn",
  DELIVERED: "BoardDelivered",
  FAILED: "BoardFailed",
  REJECTED: "BoardRejected",
  OOR: "BoardOOR",
  OTHER: "BoardOther",
  AGEING: "BoardAgeing",
} as const;

export type StationBoardTidKind = "edd" | "creturn" | "dsr" | "dsr-station" | "zero" | "ageing" | "premium" | "standard";

const DSR_BUCKETS = [BOARD_TID.DELIVERED, BOARD_TID.FAILED, BOARD_TID.REJECTED, BOARD_TID.OOR, BOARD_TID.OTHER, "Failed", "Rejected"];

export const BOARD_TID_KIND_BUCKETS: Record<StationBoardTidKind, string[]> = {
  edd: [BOARD_TID.EDD, "EDD"],
  creturn: [BOARD_TID.CRETURN, "Pickup"],
  ageing: [BOARD_TID.AGEING],
  dsr: DSR_BUCKETS,
  "dsr-station": [BOARD_TID.PHYSICAL, BOARD_TID.PENDING_TODAY, BOARD_TID.EDD, BOARD_TID.AGEING, BOARD_TID.DELIVERED, BOARD_TID.FAILED, BOARD_TID.REJECTED, BOARD_TID.OOR, BOARD_TID.OTHER, "Failed", "Rejected"],
  zero: DSR_BUCKETS,
  premium: DSR_BUCKETS,
  standard: DSR_BUCKETS,
};

export type FlashTrackingLike = {
  stationCode: string;
  trackingId: string;
  bucket: string;
  state: string;
  edd: string;
  driverId: string;
  driverName: string;
  shipOption?: string;
};

export type BoardTidExportRow = {
  stationCode: string;
  trackingId: string;
  status: string;
  currentState?: string;
  edd: string;
  driverId: string;
  driverName: string;
  report: string;
  sourceBucket?: string;
  shipOption?: string;
};

function dsrStatus(bucket: string): string {
  if (bucket === BOARD_TID.DELIVERED) return "Delivered";
  if (bucket === BOARD_TID.OTHER) return "Other / pending";
  if (bucket === BOARD_TID.OOR) return "OOR";
  if (bucket === BOARD_TID.FAILED || bucket === "Failed") return "Failed";
  if (bucket === BOARD_TID.REJECTED || bucket === "Rejected") return "Rejected";
  return bucket;
}

function mapEdd(flash: FlashTrackingLike[]): BoardTidExportRow[] {
  const preferBoard = flash.some((row) => row.bucket === BOARD_TID.EDD);
  return flash
    .filter((row) => (preferBoard ? row.bucket === BOARD_TID.EDD : row.bucket === "EDD"))
    .map((row) => ({
      stationCode: row.stationCode,
      trackingId: row.trackingId,
      status: row.state || "Inducted",
      edd: row.edd || "",
      driverId: row.driverId,
      driverName: row.driverName,
      report: "EDD",
    }))
    .filter((row) => row.trackingId);
}

function mapCReturn(flash: FlashTrackingLike[]): BoardTidExportRow[] {
  const boardStations = new Set(flash.filter(row => row.bucket === BOARD_TID.CRETURN).map(row => row.stationCode));
  return flash
    .filter((row) => (boardStations.has(row.stationCode) ? row.bucket === BOARD_TID.CRETURN : row.bucket === "Pickup"))
    .map((row) => {
      const raw = String(row.state || "").trim().toUpperCase();
      const status = CRETURN_PICKED_UP_BUCKET.has(raw) ? "PICKUP_DONE" : raw || "UNKNOWN";
      return {
        stationCode: row.stationCode,
        trackingId: row.trackingId,
        status,
        edd: row.edd || "",
        driverId: row.driverId,
        driverName: row.driverName,
        report: "C-Return",
      };
    })
    .filter((row) => row.trackingId);
}

function mapAgeing(flash: FlashTrackingLike[]): BoardTidExportRow[] {
  return flash
    .filter((row) => row.bucket === BOARD_TID.AGEING)
    .map((row) => ({
      stationCode: row.stationCode,
      trackingId: row.trackingId,
      status: row.state || "",
      edd: row.edd || "",
      driverId: row.driverId,
      driverName: row.driverName,
      report: "Ageing",
    }))
    .filter((row) => row.trackingId);
}

function mapDsr(
  flash: FlashTrackingLike[],
  mode: "dsr" | "zero" | "premium" | "standard",
): BoardTidExportRow[] {
  const dsrBuckets = new Set(DSR_BUCKETS);
  const reportLabel =
    mode === "zero" ? "Zero deliveries"
      : mode === "premium" ? "Premium DOT"
        : mode === "standard" ? "Standard DOT"
          : "DA DSR";
  let rows = flash
    .filter((row) => dsrBuckets.has(row.bucket))
    .filter((row) => {
      if (mode === "premium") return isPremiumDot(row.shipOption);
      if (mode === "standard") return isStandardDot(row.shipOption);
      return true;
    })
    .map((row) => ({
      stationCode: row.stationCode,
      trackingId: row.trackingId,
      status: dsrStatus(row.bucket),
      currentState: row.state || "",
      edd: row.edd || "",
      driverId: row.driverId,
      driverName: row.driverName,
      report: reportLabel,
      shipOption: row.shipOption || "",
    }))
    .filter((row) => row.trackingId);

  if (mode === "zero") {
    const deliveredByDriver = new Map<string, number>();
    for (const row of rows) {
      if (row.status !== "Delivered") continue;
      const id = `${row.stationCode}\t${row.driverId || "(no DA)"}`;
      deliveredByDriver.set(id, (deliveredByDriver.get(id) ?? 0) + 1);
    }
    rows = rows.filter((row) => {
      const id = `${row.stationCode}\t${row.driverId || "(no DA)"}`;
      return (deliveredByDriver.get(id) ?? 0) === 0 && row.status !== "Delivered";
    });
  }
  return rows;
}

function mapDsrStation(flash: FlashTrackingLike[]): BoardTidExportRow[] {
  const buckets = new Set(BOARD_TID_KIND_BUCKETS["dsr-station"]);
  return flash
    .filter((row) => buckets.has(row.bucket))
    .map((row) => ({
      stationCode: row.stationCode,
      trackingId: row.trackingId,
      sourceBucket: row.bucket,
      status: row.bucket === BOARD_TID.PENDING_TODAY ? "EDD pending today"
        : row.bucket === BOARD_TID.PHYSICAL ? "Physical at station"
        : row.bucket === BOARD_TID.EDD ? "Inducted inventory"
        : row.bucket === BOARD_TID.AGEING ? row.state || "At station"
          : dsrStatus(row.bucket),
      currentState: row.state || "",
      edd: row.edd || "",
      driverId: row.driverId,
      driverName: row.driverName,
      report: "DSR station",
    }))
    .filter((row) => row.trackingId);
}

/** Map worker flash tracking rows into Station board TID export rows for one report kind. */
export function mapBoardTidExportRows(
  flash: FlashTrackingLike[],
  kind: StationBoardTidKind,
): BoardTidExportRow[] {
  if (kind === "edd") return mapEdd(flash);
  if (kind === "creturn") return mapCReturn(flash);
  if (kind === "ageing") return mapAgeing(flash);
  if (kind === "dsr-station") return mapDsrStation(flash);
  if (kind === "zero") return mapDsr(flash, "zero");
  if (kind === "premium") return mapDsr(flash, "premium");
  if (kind === "standard") return mapDsr(flash, "standard");
  return mapDsr(flash, "dsr");
}

/** Flat Excel rows for the All TIDs sheet (insertion-order headers). */
export function boardTidSheetRows(rows: BoardTidExportRow[]): Record<string, unknown>[] {
  return [...rows]
    .sort(
      (a, b) =>
        a.stationCode.localeCompare(b.stationCode)
        || a.report.localeCompare(b.report)
        || a.edd.localeCompare(b.edd)
        || a.trackingId.localeCompare(b.trackingId),
    )
    .map((row) => ({
      Station: row.stationCode,
      Report: row.report,
      "Tracking ID": row.trackingId,
      Status: row.status,
      ...(row.currentState !== undefined ? { "Current Amazon state": row.currentState } : {}),
      EDD: row.edd,
      "Ship Option": row.shipOption || "",
      "DA ID": row.driverId,
      "DA Name": row.driverName,
    }));
}

export function boardTidBucketsForKinds(kinds: StationBoardTidKind[]): string[] {
  const out = new Set<string>();
  for (const kind of kinds) {
    for (const bucket of BOARD_TID_KIND_BUCKETS[kind]) out.add(bucket);
  }
  return [...out];
}

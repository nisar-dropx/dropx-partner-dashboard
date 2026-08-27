import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddStation, type EddBucketKey } from "@/lib/ops-pulse/edd-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BUCKET_LABEL: Record<EddBucketKey, string> = {
  overdue: "Overdue",
  dueToday: "Due today",
  dueTomorrow: "Due tomorrow",
  future: "Future",
  unknown: "Unknown"
};

/** Excel download of one station's live Ageing backlog — "Live backlog" (every tracking ID) + "Bucket summary" sheets. */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const result = await fetchEddStation({ stationCode });
    if (result.status === "no_snapshot") {
      return NextResponse.json({ error: `No Ageing snapshot yet for ${stationCode} — refresh the station first.` }, { status: 404 });
    }
    const payload = result.payload;

    const backlogRows = payload.packages.map((pkg) => ({
      "Tracking ID": pkg.trackingId,
      State: pkg.state ?? "",
      Bucket: BUCKET_LABEL[pkg.bucket] ?? pkg.bucket,
      EAD: pkg.ead ?? "",
      "Internal EAD": pkg.internalEAD ?? "",
      "Promised Delivery Date": pkg.promisedDeliveryDate ?? "",
      "Estimated Arrival (UTC)": pkg.estimatedArrivalTimeUTC ?? "",
      "Minutes In State": pkg.minutesInState,
      "Last Scan By": pkg.lastScanBy ?? "",
      "Driver ID": pkg.driverId ?? "",
      "DSP Name": pkg.dspName ?? "",
      "Payment Method": pkg.paymentMethod ?? "",
      City: pkg.city ?? "",
      "Postal Code": pkg.postalCode ?? "",
      "State/Province": pkg.stateProvinceCode ?? "",
      "Order ID": pkg.orderingOrderId ?? "",
      "Ship Option": pkg.shipOption ?? "",
      "Package Type": pkg.packageType ?? "",
      "Locker Name": pkg.lockerName ?? ""
    }));

    const summaryRows = (Object.keys(BUCKET_LABEL) as EddBucketKey[]).map((bucket) => ({
      Bucket: BUCKET_LABEL[bucket],
      Count: payload.buckets[bucket] ?? 0
    }));
    summaryRows.push({ Bucket: "Total live", Count: payload.totalCount });

    const filename = `ageing-${stationCode}-${payload.todayYmd || new Date().toISOString().slice(0, 10)}.xlsx`;
    return workbookResponse(
      [
        { name: "Live backlog", rows: backlogRows },
        { name: "Bucket summary", rows: summaryRows }
      ],
      filename
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Ageing report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

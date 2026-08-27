import { NextResponse } from "next/server";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { fetchCiaStation } from "@/lib/ops-pulse/cash-recon-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Excel download of one station's Cash In Associate position — summary, pending-by-driver, per-shipment detail, and the day-wise ledger. */
export async function GET(request: Request) {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    const asOfDate = url.searchParams.get("asOfDate")?.trim() ?? "";
    const fromDate = url.searchParams.get("fromDate")?.trim() ?? "";
    const toDate = url.searchParams.get("toDate")?.trim() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const payload = await fetchCiaStation(stationCode, {
      ...(asOfDate ? { asOfDate } : {}),
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {})
    });

    const summaryRows = [
      { Metric: "CIA total (with associate)", Amount: payload.summary.ciaTotal },
      { Metric: "Cash at station", Amount: payload.summary.cashAtStationTotal },
      { Metric: "Ageing total", Amount: payload.summary.ageingTotal },
      { Metric: "Deposited total", Amount: payload.summary.depositedTotal },
      { Metric: "Pending liability", Amount: payload.summary.pendingLiability },
      { Metric: "Cleared in window", Amount: payload.summary.clearedInWindow },
      { Metric: "Cash difference", Amount: payload.summary.cashDifference },
      { Metric: "Difference", Amount: payload.summary.difference },
      { Metric: "Shipment count", Amount: payload.summary.shipmentCount },
      { Metric: "Pending driver count", Amount: payload.summary.pendingDriverCount }
    ];

    const driverRows = payload.pendingDrivers.map((driver) => ({
      Driver: driver.driverName,
      "TAS ID": driver.tasId ?? "",
      "Employee ID": driver.employeeId ?? "",
      "Operational Status": driver.operationalStatus ?? "",
      "Mapped From Roster": driver.mappedFromWorkforce ? "Yes" : "No",
      "Pending Amount": driver.amount,
      "Shipment Count": driver.shipmentCount,
      Dates: driver.dates.join(", ")
    }));

    const shipmentRows = payload.pendingDrivers.flatMap((driver) =>
      driver.shipments.map((shipment) => ({
        Driver: driver.driverName,
        "TAS ID": driver.tasId ?? "",
        "Tracking ID": shipment.trackingId,
        "Shipment No": shipment.shipmentNo,
        "Pending Amount": shipment.pendingAmount,
        "Kept On": shipment.keptOnDate ?? "",
        "Cleared On": shipment.clearedOnDate ?? "",
        "Kept Days": shipment.keptDays ?? "",
        Status: shipment.status,
        "Remittance ID": shipment.remittanceId ?? "",
        "Remittance Code": shipment.remittanceCode ?? ""
      }))
    );

    const ledgerRows = payload.ledger.map((day) => ({
      Date: day.date,
      "Carry Forward In": day.carryForwardIn,
      "Expected Cash Total": day.expectedCashTotal,
      "Remittance Total Cash": day.remittanceTotalCash,
      "Short Amount": day.shortAmount,
      "Still Pending Amount": day.stillPendingAmount,
      "Forwarded Amount": day.forwardedAmount,
      "Cleared Same Day": day.clearedSameDayAmount,
      "Cleared From Prior": day.clearedFromPriorAmount,
      "Driver Count": day.driverCount
    }));

    const filename = `cia-${stationCode}-${payload.asOfDate || new Date().toISOString().slice(0, 10)}.xlsx`;
    return workbookResponse(
      [
        { name: "Summary", rows: summaryRows },
        { name: "Pending by driver", rows: driverRows },
        { name: "Shipment detail", rows: shipmentRows },
        { name: "Day-wise ledger", rows: ledgerRows }
      ],
      filename
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Cash In Associate report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

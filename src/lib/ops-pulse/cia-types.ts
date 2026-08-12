/** Cash In Associate snapshot types (cash-recon-worker network + station APIs). */

export type CiaStationRow = {
  stationCode: string;
  status: "ok" | "error" | string;
  error: string | null;
  fetchedAt: string | null;
  accountKey: string | null;
  ciaTotal: number;
  cashAtStationTotal: number;
  ageingTotal: number;
  depositedTotal: number;
  pendingLiability: number;
  clearedInWindow: number;
  cashDifference: number;
  difference: number;
  shipmentCount: number;
  pendingDriverCount: number;
  limitedByRemittanceWindow: boolean;
};

export type CiaNetworkPayload = {
  status: string;
  asOfDate: string;
  window: { from: string; to: string };
  run: {
    id: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    stationsTotal: number;
    stationsOk: number;
    stationsFailed: number;
  } | null;
  totals: {
    ciaTotal: number;
    cashAtStationTotal: number;
    ageingTotal: number;
    depositedTotal: number;
    pendingLiability: number;
    clearedInWindow: number;
    cashDifference: number;
    difference: number;
    shipmentCount: number;
    pendingDriverCount: number;
    limitedByRemittanceWindow: boolean;
  };
  stations: CiaStationRow[];
  cached: boolean;
  runSource?: "running" | "completed" | string;
  refreshProgress?: {
    id: string;
    status: string;
    asOfDate?: string;
    windowFrom?: string;
    windowTo?: string;
    startedAt?: string | null;
    stationsTotal: number;
    stationsOk: number;
    stationsFailed: number;
  } | null;
};

export type CiaDailyLedgerStationDay = {
  stationCode: string;
  date: string;
  cashWithAssociate: number;
  deposited: number;
  pending: number;
  forwarded: number;
};

export type CiaDailyLedgerDay = {
  date: string;
  cashWithAssociate: number;
  deposited: number;
  pending: number;
  forwarded: number;
  stationCount: number;
};

export type CiaDailyLedgerPayload = {
  status: string;
  asOfDate: string;
  window: { from: string; to: string };
  selectedDate: string | null;
  runSource?: string;
  run: {
    id: string;
    status: string;
    stationsTotal: number;
    stationsOk: number;
  } | null;
  totals: {
    cashWithAssociate: number;
    deposited: number;
    pending: number;
    forwarded: number;
  };
  days: CiaDailyLedgerDay[];
  stationDays: CiaDailyLedgerStationDay[];
  cached: boolean;
};

export type CiaPendingShipment = {
  trackingId: string;
  shipmentNo: string;
  pendingAmount: number;
  keptOnDate: string | null;
  clearedOnDate: string | null;
  keptDays: number | null;
  status: string;
  remittanceId: string | null;
  remittanceCode: string | null;
};

export type CiaPendingDriver = {
  driverName: string;
  tasId: string | null;
  employeeId: string | null;
  operationalStatus: string | null;
  mappedFromWorkforce: boolean;
  amount: number;
  shipmentCount: number;
  dates: string[];
  shipments: CiaPendingShipment[];
};

export type CiaStationLedgerDay = {
  date: string;
  carryForwardIn: number;
  expectedCashTotal: number;
  remittanceTotalCash: number;
  shortAmount: number;
  stillPendingAmount: number;
  forwardedAmount: number;
  clearedSameDayAmount: number;
  clearedFromPriorAmount: number;
  driverCount: number;
};

export type CiaStationPayload = {
  status: string;
  asOfDate: string;
  window: { from: string; to: string };
  runStatus: string | null;
  runId: string | null;
  stationCode: string;
  snapshotStatus: string;
  error: string | null;
  fetchedAt: string | null;
  summary: {
    ciaTotal: number;
    cashAtStationTotal: number;
    ageingTotal: number;
    depositedTotal: number;
    pendingLiability: number;
    clearedInWindow: number;
    cashDifference: number;
    difference: number;
    shipmentCount: number;
    pendingDriverCount: number;
    limitedByRemittanceWindow: boolean;
  };
  pendingDrivers: CiaPendingDriver[];
  ledger: CiaStationLedgerDay[];
  cached: boolean;
  availableReportDates?: string[];
};

export type CiaDateDriverSlice = {
  driverName: string;
  amount: number;
  shipmentCount: number;
  shipments: CiaPendingShipment[];
};

export type CiaDateRow = {
  date: string;
  displayDate: string;
  amount: number;
  driverCount: number;
  shipmentCount: number;
  drivers: CiaDateDriverSlice[];
};

const CIA_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Friendly label for YYYY-MM-DD (e.g. "10 Aug 2026"). */
export function formatCiaDisplayDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "unknown") return "Date not recorded";
  if (!CIA_DATE_RE.test(raw)) return raw;
  const parsed = new Date(`${raw}T12:00:00+05:30`);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata"
  });
}

export function todayIstYmd() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

export function addDaysYmd(ymd: string, delta: number) {
  const match = CIA_DATE_RE.exec(ymd);
  if (!match) return ymd;
  const date = new Date(`${ymd}T12:00:00+05:30`);
  date.setUTCDate(date.getUTCDate() + delta);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
}

/** Group pending shipments by the day cash was held with the driver. */
export function buildCiaDateRows(drivers: CiaPendingDriver[]): CiaDateRow[] {
  const byDate = new Map<string, Map<string, CiaDateDriverSlice>>();

  for (const driver of drivers) {
    for (const shipment of driver.shipments) {
      const day = shipment.keptOnDate?.trim() || "unknown";
      if (!byDate.has(day)) byDate.set(day, new Map());
      const driverMap = byDate.get(day)!;
      const key = driver.driverName.trim() || "Unknown driver";
      if (!driverMap.has(key)) {
        driverMap.set(key, {
          driverName: key,
          amount: 0,
          shipmentCount: 0,
          shipments: []
        });
      }
      const slice = driverMap.get(key)!;
      slice.amount += shipment.pendingAmount;
      slice.shipmentCount += 1;
      slice.shipments.push(shipment);
    }
  }

  return [...byDate.entries()]
    .map(([date, driverMap]) => {
      const dayDrivers = [...driverMap.values()].sort((a, b) => b.amount - a.amount);
      return {
        date,
        displayDate: formatCiaDisplayDate(date),
        amount: dayDrivers.reduce((sum, row) => sum + row.amount, 0),
        driverCount: dayDrivers.length,
        shipmentCount: dayDrivers.reduce((sum, row) => sum + row.shipmentCount, 0),
        drivers: dayDrivers
      };
    })
    .sort((a, b) => {
      if (a.date === "unknown") return 1;
      if (b.date === "unknown") return -1;
      return b.date.localeCompare(a.date);
    });
}

export type CiaSeverity = "critical" | "watch" | "clear" | "error";

/** Critical = meaningful Cash In Associate still with drivers. */
export function ciaSeverity(row: Pick<CiaStationRow, "status" | "pendingLiability" | "pendingDriverCount">): CiaSeverity {
  if (row.status !== "ok") return "error";
  if (row.pendingLiability >= 10_000 || row.pendingDriverCount >= 3) return "critical";
  if (row.pendingLiability > 0 || row.pendingDriverCount > 0) return "watch";
  return "clear";
}

export function ciaSeverityLabel(severity: CiaSeverity) {
  switch (severity) {
    case "critical":
      return "Critical";
    case "watch":
      return "Watch";
    case "clear":
      return "Clear";
    case "error":
      return "Error";
  }
}

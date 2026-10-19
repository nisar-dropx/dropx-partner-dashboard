import {
  allocateCombinedProductionThresholds,
  type WorkforceProductionThresholdAllocation,
  type WorkforceProductionThresholdInput
} from "../../../lib/workforce-production-threshold.ts";

export type ReportImportShipmentMonthRow = {
  client: string;
  provider_employee_id: string;
  station_code: string;
  work_date: string;
};

export type ReportImportReplacementScope = {
  client: string;
  fromDate: string;
  stationCodes: readonly string[];
  toDate: string;
};

function normalized(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function reportImportShipmentMonthKey(row: ReportImportShipmentMonthRow) {
  return [
    row.work_date,
    normalized(row.client),
    normalized(row.station_code),
    normalized(row.provider_employee_id)
  ].join("|");
}

/**
 * Incoming report rows replace the same provider/day/station record while
 * existing rows from the rest of the calendar month remain in the working
 * set. Returning the complete month is important: a backfill near the start
 * of a month can change which later units exceed the combined minimum.
 */
export function mergeReportImportShipmentMonthRows<T extends ReportImportShipmentMonthRow>(
  existingRows: readonly T[],
  incomingRows: readonly T[]
) {
  const rows = new Map<string, T>();
  existingRows.forEach((row) => rows.set(reportImportShipmentMonthKey(row), row));
  incomingRows.forEach((row) => rows.set(reportImportShipmentMonthKey(row), row));
  return [...rows.values()].sort((left, right) => reportImportShipmentMonthKey(left).localeCompare(reportImportShipmentMonthKey(right)));
}

/**
 * Removes stored rows that an authoritative import is about to replace. This
 * happens before threshold allocation so a corrected half-month file cannot
 * keep paying against a source row that the same transaction will delete.
 */
export function retainRowsOutsideReportImportReplacement<T extends ReportImportShipmentMonthRow>(
  existingRows: readonly T[],
  scope: ReportImportReplacementScope
) {
  const client = normalized(scope.client);
  const stations = new Set(scope.stationCodes.map(normalized));
  return existingRows.filter((row) => !(
    normalized(row.client) === client
    && stations.has(normalized(row.station_code))
    && row.work_date >= scope.fromDate
    && row.work_date <= scope.toDate
  ));
}

export function reportImportCalendarMonthEnd(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`;
}

export function allocateReportImportProductionThresholds(
  inputs: readonly WorkforceProductionThresholdInput[]
) {
  return new Map<string, WorkforceProductionThresholdAllocation>(
    allocateCombinedProductionThresholds(inputs).map((allocation) => [allocation.id, allocation])
  );
}

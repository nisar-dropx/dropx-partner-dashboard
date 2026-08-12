export type AmazonDeliverySourceRow = {
  station_code: string;
  work_date: string;
  provider_employee_id: string | null;
  base_amazon_delivery: number | string | null;
  smd_delivery: number | string | null;
  smd2_delivery: number | string | null;
  swa_delivery: number | string | null;
  c_return: number | string | null;
  mfn: number | string | null;
  mfn_return: number | string | null;
};

export type AmazonDeliveryTotals = {
  amazon: number;
  swa: number;
  returned: number;
  mfn: number;
  mfnReturn: number;
  smd: number;
  smd2: number;
  workload: number;
};

export type AmazonDeliveryStationDay = {
  stationCode: string;
  workDate: string;
  activeIds: number;
  totals: AmazonDeliveryTotals;
};

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function emptyAmazonDeliveryTotals(): AmazonDeliveryTotals {
  return { amazon: 0, swa: 0, returned: 0, mfn: 0, mfnReturn: 0, smd: 0, smd2: 0, workload: 0 };
}

export function addAmazonDeliveryRow(total: AmazonDeliveryTotals, row: AmazonDeliverySourceRow) {
  const amazon = numberValue(row.base_amazon_delivery);
  const smd = numberValue(row.smd_delivery);
  const smd2 = numberValue(row.smd2_delivery);
  const swa = numberValue(row.swa_delivery);
  const returned = numberValue(row.c_return);
  total.amazon += amazon;
  total.smd += smd;
  total.smd2 += smd2;
  total.swa += swa;
  total.returned += returned;
  total.mfn += numberValue(row.mfn);
  total.mfnReturn += numberValue(row.mfn_return);
  total.workload += amazon + smd + smd2 + swa + returned;
  return total;
}

export function totalAmazonDeliveryRows(rows: AmazonDeliverySourceRow[]) {
  return rows.reduce(addAmazonDeliveryRow, emptyAmazonDeliveryTotals());
}

export function summarizeAmazonDeliveryRows(rows: AmazonDeliverySourceRow[]): AmazonDeliveryStationDay[] {
  const days = new Map<string, { stationCode: string; workDate: string; ids: Set<string>; totals: AmazonDeliveryTotals }>();
  rows.forEach((row) => {
    const stationCode = String(row.station_code ?? "").trim().toUpperCase();
    const workDate = String(row.work_date ?? "").trim();
    if (!stationCode || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return;
    const key = `${stationCode}|${workDate}`;
    const current = days.get(key) ?? {
      stationCode,
      workDate,
      ids: new Set<string>(),
      totals: emptyAmazonDeliveryTotals()
    };
    const associateId = String(row.provider_employee_id ?? "").trim().toUpperCase();
    if (associateId) current.ids.add(associateId);
    addAmazonDeliveryRow(current.totals, row);
    days.set(key, current);
  });
  return [...days.values()]
    .map((day) => ({ stationCode: day.stationCode, workDate: day.workDate, activeIds: day.ids.size, totals: day.totals }))
    .sort((left, right) => left.workDate.localeCompare(right.workDate) || left.stationCode.localeCompare(right.stationCode));
}

export type LossDebit = {
  recovery_key: string;
  loss_month: string;
  case_key: string;
  shipment_id?: string;
  station_code: string;
  employee_ref: string;
  employee_code: string;
  full_name: string;
  designation: string;
  amount: number;
  payroll_month: string;
  is_deducted: boolean;
};
export function filterLossDebits(
  rows: LossDebit[],
  f: {
    month?: string;
    station?: string;
    person?: string;
    designation?: string;
  },
) {
  return rows.filter(
    (r) =>
      (!f.month || r.payroll_month === f.month) &&
      (!f.station || r.station_code === f.station) &&
      (!f.person || r.employee_ref === f.person) &&
      (!f.designation || r.designation === f.designation),
  );
}
export function summarizeLossDebits(
  rows: LossDebit[],
  by: "station" | "person" | "month",
) {
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      detail: string;
      people: Set<string>;
      shipments: Set<string>;
      deducted: number;
      draft: number;
    }
  >();
  for (const r of rows) {
    const key =
      by === "station"
        ? r.station_code
        : by === "person"
          ? r.employee_ref
          : r.payroll_month;
    const g = groups.get(key) || {
      key,
      label: by === "person" ? r.full_name || r.employee_code : key,
      detail: by === "person" ? `${r.employee_code} · ${r.designation}` : "",
      people: new Set<string>(),
      shipments: new Set<string>(),
      deducted: 0,
      draft: 0,
    };
    g.people.add(r.employee_ref);
    g.shipments.add(`${r.loss_month}|${r.case_key}`);
    if (r.is_deducted) g.deducted += r.amount;
    else g.draft += r.amount;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      people: g.people.size,
      shipments: g.shipments.size,
      deducted: Math.round(g.deducted * 100) / 100,
      draft: Math.round(g.draft * 100) / 100,
    }))
    .sort((a, b) =>
      by === "month"
        ? b.key.localeCompare(a.key)
        : b.deducted - a.deducted || a.label.localeCompare(b.label),
    );
}

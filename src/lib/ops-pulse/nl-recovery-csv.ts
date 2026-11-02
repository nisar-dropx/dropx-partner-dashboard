import {
  recoveryCsv,
  type NlCase,
  type Recovery,
} from "./nl-loss-policy";

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);

function planSummary(r: Recovery) {
  if (r.recovery_mode !== "installments") return "Full debit";
  return r.installment_basis === "months"
    ? `Recurring debit · ${Number(r.installment_value)} months`
    : `Recurring debit · ${money(Number(r.installment_value))} a month`;
}

export const RECOVERY_CSV_COLUMNS = [
  "Month",
  "Station",
  "Shipment ID",
  "Loss reason",
  "Sub reason",
  "Amazon decision",
  "Recoverable value",
  "Recovery outcome",
  "Deduction month",
  "Recovery method",
  "Monthly amount",
  "Instalments",
  "Re-dispute reason",
  "Detailing",
  "CCTV link",
  "Employee ID",
  "Employee name",
  "Individual amount",
  "Remarks",
  "Updated by",
  "Updated at",
] as const;

export const RECOVERY_PENDING_ACTION = "__pending__";

export function recoveryActionCode(c: NlCase) {
  const r = c.recovery && !c.recovery.is_deleted ? c.recovery : null;
  return r?.outcome_code || RECOVERY_PENDING_ACTION;
}

export function recoveryActionLabel(c: NlCase) {
  const r = c.recovery && !c.recovery.is_deleted ? c.recovery : null;
  return r?.outcome_label || "Pending update";
}

export function recoveryCaseCsvRows(cases: NlCase[]) {
  return cases.flatMap((c) => {
    const r = c.recovery && !c.recovery.is_deleted ? c.recovery : null;
    return (r?.allocations.length ? r.allocations : [null]).map((p) => [
      c.month,
      c.station_code,
      c.details.tid,
      c.details.category,
      c.details.sub_category,
      c.source_status,
      c.amount,
      r?.outcome_label || "Pending update",
      r?.deduction_month,
      r ? planSummary(r) : "",
      p?.monthly_amount ?? p?.amount,
      p?.installments?.length || (p ? 1 : ""),
      r?.recovery_details?.reason,
      r?.recovery_details?.details,
      r?.recovery_details?.cctv_url,
      p?.employee_code,
      p?.full_name,
      p?.amount,
      r?.remarks,
      r?.updated_by_name,
      r?.updated_at,
    ]);
  });
}

export function downloadRecoveryCsv(cases: NlCase[], fileName: string) {
  const url = URL.createObjectURL(
    new Blob(
      [
        "\ufeff" +
          [RECOVERY_CSV_COLUMNS, ...recoveryCaseCsvRows(cases)]
            .map((r) => r.map(recoveryCsv).join(","))
            .join("\r\n"),
      ],
      { type: "text/csv;charset=utf-8" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

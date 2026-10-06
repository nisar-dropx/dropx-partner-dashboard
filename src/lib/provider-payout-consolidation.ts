import type { WorkforcePayoutRow } from "../components/workforce-payout-table.tsx";
import { summarizePaymentMethodAmounts, summarizePayoutBreakdownLines } from "./workforce-payout-summary.ts";
import { groupPayoutItemsBySubjectLocation } from "./workforce-payout-location-groups.ts";

export type ProviderPayoutSegment = {
  workforceId: string;
  categoryCode: string;
  panNumber: string | null;
  paymentSetupKey?: string;
  row: WorkforcePayoutRow;
};

export type ConsolidatedProviderPayout = {
  workforceId: string;
  categoryCode: string;
  panNumber: string | null;
  row: WorkforcePayoutRow;
};

const rounded = (value: number) => Math.round(value * 100) / 100;

function joined(values: string[], fallback: string) {
  const unique = [...new Set(values.map((value) => String(value ?? "").trim()).filter((value) => value && value !== "-"))];
  return unique.join(" / ") || fallback;
}

export function consolidateProviderPayoutSegments(segments: ProviderPayoutSegment[]) {
  const grouped = groupPayoutItemsBySubjectLocation(
    segments,
    (segment) => segment.workforceId,
    (segment) => segment.row.locationId
  );

  const conflicts: string[] = [];
  const rows: ConsolidatedProviderPayout[] = [];

  for (const { subjectId: workforceId, locationId, items: workerSegments } of grouped) {
    const first = workerSegments[0];
    if (!first) continue;
    const dailyByDate = new Map<string, { day: WorkforcePayoutRow["dailyBreakdown"][number]; paymentSetupKey: string }>();
    let overlap = false;
    for (const segment of workerSegments) {
      for (const day of segment.row.dailyBreakdown) {
        const current = dailyByDate.get(day.date);
        if (!current) {
          dailyByDate.set(day.date, { day, paymentSetupKey: segment.paymentSetupKey ?? "" });
          continue;
        }
        if (!segment.paymentSetupKey || current.paymentSetupKey !== segment.paymentSetupKey) {
          overlap = true;
          break;
        }
        current.day = {
          date: day.date,
          workDayUnits: Math.max(current.day.workDayUnits, day.workDayUnits),
          attendanceSource: current.day.attendanceSource === day.attendanceSource ? day.attendanceSource : "Mixed",
          methodAmounts: summarizePaymentMethodAmounts([
            ...current.day.methodAmounts.map((method) => ({ methodId: method.id, label: method.label, amount: method.amount })),
            ...day.methodAmounts.map((method) => ({ methodId: method.id, label: method.label, amount: method.amount }))
          ]),
          baseAmount: rounded(current.day.baseAmount + day.baseAmount),
          lines: [...current.day.lines, ...day.lines]
        };
      }
      if (overlap) break;
    }
    if (overlap) {
      conflicts.push(workforceId);
      continue;
    }

    const dailyBreakdown = [...dailyByDate.values()].map(({ day }) => day).sort((left, right) => right.date.localeCompare(left.date));
    const productionBreakdown = summarizePayoutBreakdownLines(dailyBreakdown.flatMap((day) => day.lines))
      .sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || left.label.localeCompare(right.label)
        || left.rate - right.rate);
    const baseAmount = rounded(dailyBreakdown.reduce((sum, day) => sum + day.baseAmount, 0));
    const additions = rounded(workerSegments.reduce((sum, segment) => sum + segment.row.additions, 0));
    const grossPayment = rounded(baseAmount + additions);
    const workDays = rounded(dailyBreakdown.reduce((sum, day) => sum + Math.max(0, Math.min(1, day.workDayUnits)), 0));
    const workDaySources = [...new Set(dailyBreakdown.map((day) => day.attendanceSource).filter(Boolean))];
    const paymentMethodBreakdown = summarizePaymentMethodAmounts(workerSegments.flatMap((segment) =>
      segment.row.paymentMethodBreakdown.map((method) => ({ methodId: method.id, label: method.label, amount: method.amount }))
    ));
    const status = workerSegments.some((segment) => segment.row.status === "Configuration incomplete")
      ? "Configuration incomplete"
      : grossPayment > 0
        ? "Ready for review"
        : workerSegments.some((segment) => ["No eligible attendance", "No eligible accrual"].includes(segment.row.status))
          ? "No eligible accrual"
          : "Awaiting production";

    rows.push({
      workforceId,
      categoryCode: first.categoryCode,
      panNumber: first.panNumber,
      row: {
        ...first.row,
        id: `provider-${workforceId}-${locationId || "unassigned"}`,
        providerMemberId: joined(workerSegments.map((segment) => segment.row.providerMemberId), "-"),
        providerMemberName: joined(workerSegments.map((segment) => segment.row.providerMemberName), "-"),
        locationId: locationId || null,
        location: joined(workerSegments.map((segment) => segment.row.location), "-"),
        provider: joined(workerSegments.map((segment) => segment.row.provider), "-"),
        model: joined(workerSegments.map((segment) => segment.row.model), "All models"),
        paymentMethod: paymentMethodBreakdown.map((method) => method.label).join(" / ") || "-",
        paymentMethodBreakdown,
        workDays,
        workDaysSource: workDaySources.length > 1 ? "Mixed" : workDaySources[0] ?? "-",
        production: rounded(productionBreakdown.reduce((sum, line) => sum + line.count, 0)),
        productionBreakdown,
        dailyBreakdown,
        baseAmount,
        additions,
        grossPayment,
        deductions: 0,
        deductionBreakdown: [],
        netAmount: grossPayment,
        status
      }
    });
  }

  return { rows, conflicts };
}

/** Presentation only: pay is supplied by the shared payout engine, never recalculated here. */
export type InsightPayRow = {
  id: string; name: string; dropxId: string; paymentMethod: string;
  paymentDetailsAvailable: boolean; status: string;
  dailyBreakdown: { date: string; baseAmount: number; attendanceSource: string; attendanceRange?: unknown; lines?: {code: string; label: string; schedule?: string; count: number; rate: number; amount: number}[] }[];
};
export type InsightShipment = { work_date: string; total_delivery: number | string | null; amazon_delivery?: number | string | null; swa_delivery?: number | string | null };
export type ProviderMappingInsights = ReturnType<typeof buildProviderMappingInsights>;
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function insightPeriod(month: string, today: string) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || month > today.slice(0, 7)) return null;
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
  return { from: `${month}-01`, to: end < today ? end : today };
}

export function buildProviderMappingInsights(input: {
  from: string; to: string; shipments: InsightShipment[]; payRows: InsightPayRow[];
  costError?: string | null;
}) {
  const delivered = new Map<string, number>();
  for (const row of input.shipments) {
    if (row.work_date < input.from || row.work_date > input.to) continue;
    const count = row.total_delivery == null
      ? Number(row.amazon_delivery ?? 0) + Number(row.swa_delivery ?? 0) : Number(row.total_delivery);
    if (Number.isFinite(count) && count >= 0) delivered.set(row.work_date, (delivered.get(row.work_date) ?? 0) + count);
  }
  const latestReport = [...delivered.keys()].sort().at(-1) ?? null;
  const byDate = new Map<string, InsightPayRow['dailyBreakdown']>();
  const incomplete = input.payRows.some(row => !row.paymentDetailsAvailable || ['Configuration incomplete', 'Route distance pending'].includes(row.status));
  const costIssue = input.costError || (incomplete ? 'Payment setup or attendance needs review.' : !input.payRows.length ? 'No saved pay mapping for this period.' : null);
  for (const row of input.payRows) for (const day of row.dailyBreakdown) {
    if (day.date >= input.from && day.date <= (latestReport ?? input.to)) byDate.set(day.date, [...(byDate.get(day.date) ?? []), day]);
  }
  const days: { date: string; deliveries: number | null; cost: number | null; cps: number | null; note: string }[] = [];
  for (let date = input.from; date <= (latestReport ?? input.to);) {
    const source = byDate.get(date) ?? [];
    const count = delivered.get(date) ?? null;
    const adhoc = source.some(day => day.attendanceSource.startsWith('Paid ad hoc'));
    const range = source.some(day => day.attendanceRange);
    const cost = !costIssue && source.length ? round(source.reduce((sum, day) => sum + day.baseAmount, 0)) : null;
    days.push({ date, deliveries: count, cost,
      cps: cost != null && count != null && count > 0 && !adhoc && !range ? round(cost / count) : null,
      note: adhoc ? 'Paid ad hoc · outside mapped pay' : range ? 'Attendance entered for a range' : count == null ? 'No imported report' : cost == null ? 'Pay unavailable' : '' });
    date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  }
  const deliveries = days.reduce((sum, day) => sum + (day.deliveries ?? 0), 0);
  // Do not present incomplete mapping coverage as free delivery or a complete CPS.
  const missingPay = days.some(day => (day.deliveries ?? 0) > 0 && day.cost == null);
  const cost = !costIssue && latestReport && !missingPay ? round(days.reduce((sum, day) => sum + (day.cost ?? 0), 0)) : null;
  const hasAdhoc = days.some(day => day.note.startsWith('Paid ad hoc'));
  const breakdown = new Map<string, {label: string; schedule: string; count: number; rate: number; amount: number}>();
  for (const source of byDate.values()) for (const day of source) for (const line of day.lines ?? []) {
    const key = JSON.stringify([line.code, line.schedule, line.rate]);
    const entry = breakdown.get(key) ?? {label: line.label, schedule: line.schedule ?? 'per_unit', count: 0, rate: line.rate, amount: 0};
    entry.count += line.count; entry.amount += line.amount;
    breakdown.set(key, entry);
  }
  return { from: input.from, to: input.to, latestReport, deliveries, cost,
    cps: cost != null && deliveries > 0 && !hasAdhoc ? round(cost / deliveries) : null,
    costIssue: costIssue || (missingPay ? 'Some delivery days have no saved pay mapping.' : hasAdhoc ? 'Ad hoc payments are separate; combined CPS is unavailable.' : null),
    methods: [...new Set(input.payRows.map(row => row.paymentMethod).filter(Boolean))],
    people: [...new Set(input.payRows.map(row => [row.name, row.dropxId].filter(Boolean).join(' · ')))],
    paymentBreakdown: [...breakdown.values()].map(line => ({...line, count: round(line.count), amount: round(line.amount)})),
    days: days.reverse() };
}

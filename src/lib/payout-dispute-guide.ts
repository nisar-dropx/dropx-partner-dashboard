import { publishedPayoutBreakdown } from "../../apps/connect/src/lib/published-payout-breakdown.ts";
import { monthlyAttendanceAmountForAggregateUnits, workforcePaymentPolicyForDate } from "./workforce-payment-policy.ts";

type Row = Record<string, any>;
export const DISPUTE_ISSUES = [
  { id: "attendance", label: "Missing / incorrect work day", area: "work_days", reasons: ["I worked but the day is missing", "Full day shown as half day", "Wrong attendance"] },
  { id: "deduction", label: "Wrong deduction", area: "deduction", reasons: ["Wrong amount", "Already recovered", "Not my loss / advance", "Please explain this deduction"] },
  { id: "fuel", label: "Kilometres / fuel", area: "allowances", reasons: ["Route / kilometres missing", "Wrong kilometres", "Wrong rate per kilometre", "Fuel payment missing"] },
  { id: "production", label: "Delivery / pickup count", area: "delivery", reasons: ["Count is missing", "Count is incorrect", "Wrong rate"] },
  { id: "salary", label: "Salary / payment rate", area: "attendance_pay", reasons: ["Wrong salary amount", "Wrong payment rate", "Wrong effective dates", "Payment missing"] },
  { id: "allowance", label: "Incentive / allowance", area: "allowances", reasons: ["Payment missing", "Wrong amount", "Please check eligibility"] },
] as const;
export type DailyCountClaim = { date: string; component: string; value: number };
export type GuidedClaim = { schema: 3; issue: string; component: string; dates: string[]; concern: string; expected: string; note: string; counts?: DailyCountClaim[]; attachment?: { path: string; name: string } };
export type GuideItem = { key: string; code: string; label: string; kind: string; amount: number; rate: number | null; units: number | null; recoveryKey?: string };
export function disputeConcerns(issue: string, component?: GuideItem) {
  if(issue === "deduction" && component) {
    if(/TDS/i.test(component.code)) return ["Wrong TDS amount", "PAN details need checking", "Please explain my TDS"];
    if(component.recoveryKey || /LOSS/i.test(component.code)) return ["Not my loss", "Wrongly deducted", "Already recovered", "Wrong loss amount", "Please explain this loss"];
    if(/ADVANCE/i.test(component.code)) return ["Not my advance", "Wrongly deducted", "Already recovered", "Wrong advance recovery", "Please explain this advance"];
  }
  return [...(DISPUTE_ISSUES.find(i=>i.id===issue)?.reasons??[])];
}
export const cash = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const isDailyCountConcern = (claim: {issue?: string; concern?: string}) => claim.issue === "production" && !!claim.concern && !/rate/i.test(claim.concern);
export const needsExpectedValue = (claim: {issue?: string; concern?: string}) => !isDailyCountConcern(claim) && !(claim.issue === "deduction" && /not my|wrongly deducted|already recovered|explain|PAN/i.test(claim.concern ?? ""));
export function productionItems(items: GuideItem[]) {
  return items.filter((item, index) => item.kind === "production" && items.findIndex(other => other.kind === "production" && other.code === item.code) === index);
}
export function publishedDayCount(day: Row | undefined, code: string): number | null {
  const lines = (day?.lines ?? []).filter((line: Row) => line.code === code);
  if (!lines.length || lines.some((line: Row) => numeric(line.count) === null)) return null;
  return lines.reduce((sum: number, line: Row) => sum + Number(line.count), 0);
}
/** A source sync alone must not invalidate an unchanged reviewed calculation. */
export function disputeEvidenceValues(value: unknown) {
  return JSON.stringify(value,(key,item)=>["updated_at","updatedAt","checkedAt","dependency_hash"].includes(key)?undefined:item);
}
const numeric = (n: unknown): number | null => n == null || n === "" || !Number.isFinite(Number(n)) ? null : Number(n);
export function disputeDays(snapshot: Row): Row[] {
  const days = new Map<string, Row>();
  for (const line of snapshot.lines ?? []) {
    if (["deduction", "additional_payment", "incentive"].includes(line.source_type) || !line.work_date) continue;
    const c = line.calculation_snapshot ?? {};
    const prior = days.get(line.work_date) ?? { date: line.work_date, units: 0, attendanceKnown: false, deliveries: 0, deliveryKnown: false, providerIds: [], lines: [] };
    const u = numeric(c.workDayUnits);
    if (u !== null) { prior.units += u; prior.attendanceKnown = true; }
    const delivered = numeric(c.counts?.totalDelivery);
    if (delivered !== null) { prior.deliveries += delivered; prior.deliveryKnown = true; }
    if (line.provider_member_id && !prior.providerIds.includes(line.provider_member_id)) prior.providerIds.push(line.provider_member_id);
    prior.lines.push(...(c.paymentLines ?? []));
    days.set(line.work_date, prior);
  }
  for (const day of snapshot.worksheet?.daily_breakdown ?? []) {
    if (!days.has(day.date)) days.set(day.date, { date: day.date, units: numeric(day.workDayUnits), attendanceKnown: numeric(day.workDayUnits) !== null, deliveries: null, deliveryKnown: false, providerIds: [], lines: day.lines ?? [] });
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function disputeItems(snapshot: Row): GuideItem[] {
  const b = publishedPayoutBreakdown(snapshot, snapshot.lines ?? [], snapshot.item ?? {});
  const deductions=new Map<string,GuideItem>();
  for(const d of b.deductions){const key=`deduction:${d.code}:${d.recoveryKey??"head"}`;const old=deductions.get(key);deductions.set(key,{key,code:d.code,label:d.label,kind:"deduction",amount:cash((old?.amount??0)+d.amount),units:null,rate:null,recoveryKey:d.recoveryKey});}
  return [
    { key: "attendance", code: "attendance", label: "Work days", kind: "attendance", amount: 0, rate: null, units: numeric(snapshot.item?.work_days) },
    ...b.earnings.map((e, i) => ({ key: `earning:${e.code}:${i}`, code: e.code, label: e.label,
      kind: /KM|FUEL|KILOMET/i.test(`${e.code} ${e.label}`) ? "fuel" : ["per_day", "per_month", "per_hour"].includes(e.basis) ? "salary" : e.basis === "per_unit" ? "production" : "allowance", amount: e.amount, rate: e.rate, units: e.units })),
    ...deductions.values(),
    ...(snapshot.worksheet?.incentive_breakdown??[]).map((i:Row)=>({key:`incentive:${i.code}`,code:i.code,label:i.label||i.code,kind:"allowance",amount:Number(i.amount),rate:null,units:null}))
  ];
}
export function normalizeGuidedClaim(snapshot: Row, raw: Row): GuidedClaim {
  const issue = DISPUTE_ISSUES.find(i => i.id === raw.issue);
  if (!issue) throw new Error("Choose what is wrong with your payout.");
  const component = disputeItems(snapshot).find(i => i.key === raw.component && i.kind === issue.id);
  if (!component) throw new Error("Select the actual payment or deduction from your payout.");
  if (!disputeConcerns(issue.id,component).includes(raw.concern)) throw new Error("Choose what needs checking.");
  const available = new Set(disputeDays(snapshot).map(d => d.date));
  const dates = [...new Set(Array.isArray(raw.dates) ? raw.dates.map(String) : [])].sort() as string[];
  if (!["deduction","allowance"].includes(issue.id) && (!dates.length || dates.length > 31 || dates.some(d => !available.has(d)))) throw new Error("Select the affected dates from this payout.");
  const note = String(raw.note ?? "").trim().slice(0, 1000);
  const expected = needsExpectedValue(raw) ? String(raw.expected ?? "").trim() : "";
  if (expected && (!/^\d+(\.\d{1,2})?$/.test(expected) || Number(expected) > 1e7)) throw new Error("Enter a valid expected value, or leave it blank.");
  let counts: DailyCountClaim[] | undefined;
  if (raw.counts !== undefined) {
    if (!isDailyCountConcern(raw) || !Array.isArray(raw.counts) || !raw.counts.length || raw.counts.length > 124) throw new Error("Enter the correct counts for your selected dates.");
    const items = productionItems(disputeItems(snapshot)), days = disputeDays(snapshot), seen = new Set<string>();
    counts = [];
    for (const row of raw.counts) {
      const item = items.find(item => item.key === row?.component);
      const day = days.find(day => day.date === row?.date);
      if (!item || !day || !dates.includes(row.date)) throw new Error("Choose a published delivery or return item on a selected date.");
      const key = `${row.date}:${item.code}`;
      if (seen.has(key)) throw new Error("Each daily count can only be included once.");
      seen.add(key);
      if (row.value === "" || row.value == null || !/^\d+$/.test(String(row.value)) || Number(row.value) > 1e7) throw new Error("Enter whole-number counts, including 0 when needed.");
      const current = publishedDayCount(day, item.code);
      if (current === null) throw new Error(`${item.label}: no published count for ${row.date}. Ask the payout team to refresh this source.`);
      if (Number(row.value) !== current) counts.push({ date: row.date, component: item.key, value: Number(row.value) });
    }
    if (dates.some(date => !counts!.some(row => row.date === date))) throw new Error("Change at least one count for each selected date, or unselect that date.");
    counts.sort((a, b) => a.date.localeCompare(b.date) || a.component.localeCompare(b.component));
  }
  return { schema: 3, issue: issue.id, component: component.key, dates: ["deduction","allowance"].includes(issue.id) ? [] : dates, concern: raw.concern, expected, note, ...(counts ? { counts } : {}) };
}
export function claimDescription(snapshot: Row, claim: GuidedClaim) {
  const item = disputeItems(snapshot).find(i => i.key === claim.component)!;
  const counts = claim.counts?.map(row => `${row.date} · ${disputeItems(snapshot).find(item => item.key === row.component)?.label}: ${row.value}`).join("; ");
  return `${claim.counts ? "Daily activity" : item.label}: ${claim.concern}${counts ? ` · ${counts}` : claim.dates.length ? ` · ${claim.dates.join(", ")}` : ""}${claim.expected ? ` · Expected ${claim.expected}` : ""}${claim.note ? `\n${claim.note}` : ""}`.slice(0, 2000);
}
export type GuidedField = { key: string; label: string; date: string; code: string; recoveryKey?: string; selector: string; current: number; claimed?: number; unit: string; rate: number | null; lines?: Row[] };
export function guidedFields(snapshot: Row, claim: GuidedClaim): GuidedField[] {
  const component = disputeItems(snapshot).find(i => i.key === claim.component);
  if (!component) return [];
  if (claim.issue === "deduction") return [{ key: "value_0", label: component.label, date: "", code: component.code, recoveryKey: component.recoveryKey, selector: "deduction", current: component.amount, unit: "₹", rate: 1 }];
  if (claim.issue === "allowance") return [{key:"value_0",label:component.label,date:"",code:component.code,selector:component.key.startsWith("incentive:")?"incentive":"addition",current:component.amount,unit:"₹",rate:1}];
  const days = disputeDays(snapshot);
  const targets = claim.counts ?? claim.dates.map(date => ({date, component: claim.component}));
  return targets.map((target, i) => {
    const date = target.date;
    const component = disputeItems(snapshot).find(item => item.key === target.component)!;
    const day = days.find(d => d.date === date);
    if (!day) throw new Error(`Payout evidence is unavailable for ${date}.`);
    if (claim.issue === "attendance") {
      if (!day.attendanceKnown) throw new Error(`Attendance units are not recorded for ${date}.`);
      return { key: `value_${i}`, label: "Work day", date, code: "attendance", selector: "attendance", current: day.units, unit: "days", rate: null, lines: day.lines };
    }
    const lines = day.lines.filter((l: Row) => l.code === component.code);
    if (!lines.length) throw new Error(`${component.label}: no published input for ${date}. Ask the payout team to refresh this source.`);
    const rateIssue = /rate/i.test(claim.concern);
    const selector = rateIssue ? "rate" : ["fuel", "production"].includes(claim.issue) ? "count" : "amount";
    const rates = [...new Set(lines.map((l: Row) => numeric(l.rate)))];
    if (selector !== "amount" && (rates.length !== 1 || rates[0] === null)) throw new Error("Multiple or missing rates: check the dated payment mappings first.");
    return { key: `value_${i}`, label: component.label, date, code: component.code, selector,
      current: selector === "rate" ? Number(rates[0]) : lines.reduce((n: number, l: Row) => n + Number(l[selector] ?? 0), 0),
      ...("value" in target ? {claimed: Number(target.value)} : {}),
      unit: selector === "count" ? claim.issue === "fuel" ? "km" : "count" : "₹", rate: rates.length === 1 ? numeric(rates[0]) : null, lines };
  });
}
export type DisputePricingContext = { policies: Row[]; percentageDeductions: { code: string; rate: number }[]; error?: string; checkedAt: string };
export function buildGuidedPlan(snapshot: Row, claim: GuidedClaim, form: FormData, context: DisputePricingContext) {
  if (context.error) throw new Error(context.error);
  const fields = guidedFields(snapshot, claim);
  if (!fields.length) throw new Error("Choose a specific payout item before reviewing.");
  const items = fields.map(field => {
    if (form.get(`checked_${field.key}`) !== "on") throw new Error(`Check the supporting evidence for ${field.date || field.label}.`);
    const raw = String(form.get(field.key) ?? "");
    if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) > 1e7) throw new Error(`Enter the validated ${field.unit} for ${field.date || field.label}.`);
    const proposed = Number(raw);
    if (claim.issue === "production" && field.selector === "count" && !Number.isInteger(proposed)) throw new Error("Delivery, return and pickup counts must be whole numbers.");
    if (field.selector === "attendance" && ![0, 0.5, 1].includes(proposed)) throw new Error("A day must be absent (0), half day (0.5), or present (1).");
    let delta = 0;
    if (field.selector === "count") {
      if (field.lines?.some(l => l.thresholdPeriod && l.thresholdPeriod !== "daily")) throw new Error("This item has a period threshold. Recalculate the payout source before proposing a correction.");
      delta = (proposed - field.current) * Number(field.rate);
    } else if (field.selector === "rate") {
      if (field.lines?.some(l => l.schedule === "per_month")) {
        const days=disputeDays(snapshot),day=days.find(d=>d.date===field.date)!;
        const beforeUnits=days.filter(d=>d.date<field.date).reduce((n,d)=>n+Number(d.units??0),0);
        const policy=workforcePaymentPolicyForDate(context.policies as any,field.date);
        const before=monthlyAttendanceAmountForAggregateUnits({monthlyAmount:field.current,date:field.date,attendanceUnits:day.units,cumulativeAttendanceUnitsBefore:beforeUnits,policy});
        const recorded=field.lines!.reduce((n,l)=>n+Number(l.amount),0);
        if(Math.abs(before.amount-recorded)>0.02)throw new Error("Monthly payment basis needs source recalculation before approval.");
        const after=monthlyAttendanceAmountForAggregateUnits({monthlyAmount:proposed,date:field.date,attendanceUnits:day.units,cumulativeAttendanceUnitsBefore:beforeUnits,policy});
        delta=after.amount-recorded;
      } else delta = (proposed - field.current) * field.lines!.reduce((n, l) => n + Number(l.count), 0);
    } else if (field.selector !== "attendance") delta = (proposed - field.current) * (field.selector === "deduction" ? -1 : 1);
    return { area: field.key, kind: claim.issue === "deduction" ? "deduction" : claim.issue === "attendance" ? "attendance" : "production", target_field: `${field.label}${field.date ? ` · ${field.date}` : ""}`, unit: field.unit, current_value: field.current, proposed_value: proposed, unit_rate: field.rate, expected_delta_paise: Math.round(cash(delta) * 100), selector: field.selector, code: field.code, date: field.date, recovery_key: field.recoveryKey ?? null };
  });
  let grossDelta = 0, deductionDelta = 0;
  if (claim.issue === "attendance") {
    const days = disputeDays(snapshot);
    const monthly = new Map<string, Row>();
    for (const day of days) for (const line of day.lines) if (line.schedule === "per_month") {
      const existing = monthly.get(line.code);
      if (existing && existing.rate !== line.rate) throw new Error("Monthly rate changes require a source recalculation before approval.");
      monthly.set(line.code, line);
    }
    const oldUnits = days.reduce((n, d) => n + Number(d.units ?? 0), 0);
    const newUnits = oldUnits + items.reduce((n, i) => n + i.proposed_value - i.current_value, 0);
    const policyDates = new Set(days.map(d => workforcePaymentPolicyForDate(context.policies as any, d.date).effective_from));
    if (policyDates.size > 1) throw new Error("Payment policy changed within this period. Recalculate the source before approval.");
    for (const [code, line] of monthly) {
      const policy = workforcePaymentPolicyForDate(context.policies as any, days[0].date);
      const before = monthlyAttendanceAmountForAggregateUnits({ monthlyAmount: line.rate, date: days[0].date, attendanceUnits: oldUnits, policy });
      const after = monthlyAttendanceAmountForAggregateUnits({ monthlyAmount: line.rate, date: days[0].date, attendanceUnits: newUnits, policy });
      const recorded = days.reduce((n, d) => n + d.lines.filter((l: Row) => l.code === code).reduce((s: number, l: Row) => s + Number(l.amount), 0), 0);
      if (Math.abs(before.amount - recorded) > 0.02) throw new Error("The current payment policy differs from this publication. Refresh the payout source before approval.");
      grossDelta += after.amount - before.amount;
    }
    for (const item of items) {
      const day = days.find(d => d.date === item.date)!;
      for (const line of day.lines) {
        if (line.schedule === "per_hour") throw new Error("Hourly pay requires verified worked hours in the payout source.");
        if (line.schedule === "per_day") grossDelta += (item.proposed_value - item.current_value) * Number(line.rate);
      }
    }
    if (!monthly.size && !days.some(d => d.lines.some((l: Row) => l.schedule === "per_day"))) throw new Error("No attendance-based payment is recorded in this payout.");
  } else for (const item of items) {
    if (item.selector === "deduction") deductionDelta += item.proposed_value - item.current_value;
    else grossDelta += item.expected_delta_paise / 100;
  }
  const grossBefore = Number(snapshot.item.gross_amount);
  const deductionsBefore = Number(snapshot.item.deduction_amount);
  const netBefore = Number(snapshot.item.net_amount);
  const automatic = context.percentageDeductions.map(head => ({ code: head.code, before: cash(grossBefore * head.rate / 100), after: cash((grossBefore + grossDelta) * head.rate / 100), rate: head.rate }));
  if (grossDelta) deductionDelta += automatic.reduce((n, h) => n + h.after - h.before, 0);
  const delta = cash(grossDelta - deductionDelta);
  if (!items.some(i => i.current_value !== i.proposed_value)) throw new Error("No value changed. Request clarification or propose rejection.");
  return { schema: 3, kind: claim.issue === "deduction" ? "deduction" : "attendance", target_field: items.map(i => i.target_field).join("; "), current_value: items.map(i => i.current_value).join("; "), proposed_value: items.map(i => i.proposed_value).join("; "), items, expected_delta_paise: Math.round(delta * 100), claim,
    totals: { gross_before: grossBefore, gross_after: cash(grossBefore + grossDelta), deductions_before: deductionsBefore, deductions_after: cash(deductionsBefore + deductionDelta), net_before: cash(netBefore), net_after: cash(netBefore + delta) }, automatic_deductions: automatic, evidence_checked_at: context.checkedAt };
}

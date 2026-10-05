export type CostInput = { amount_requested: unknown; amount: unknown; amount_approved?: unknown; status?: string | null; approval_status?: string | null };
export function costNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
}
export function expenseVariance(row: CostInput) {
  const estimated = costNumber(row.amount_requested), actual = costNumber(row.amount);
  const delta = estimated != null && actual != null ? Math.round((actual - estimated) * 100) / 100 : null;
  const excluded = [row.status, row.approval_status].some(s => /^(rejected|cancelled|returned|draft)$/i.test(s ?? ''));
  return { estimated, actual, delta, percent: delta != null && estimated ? delta / estimated * 100 : null,
    overrun: !excluded && delta != null && delta > 0, excluded,
    state: excluded ? 'Excluded' : actual == null ? 'Actual pending' : estimated == null ? 'Estimate missing' : delta! > 0 ? 'Over estimate' : 'Within estimate' };
}
export function estimatedCps(amount: unknown, shipments: unknown) {
  const value = costNumber(amount), count = costNumber(shipments);
  return value != null && count != null && Number.isInteger(count) && count > 0 ? value / count : null;
}
export function estimatedShipments(answers: Array<{ answer_value: string | null; payment_head_questions?: { question_text: string } | null }>) {
  const estimate = answers.find(a => /^estimated shipments$/i.test(a.payment_head_questions?.question_text.trim() ?? ''));
  const value = costNumber(estimate?.answer_value);
  if (value != null && Number.isInteger(value) && value > 0) return value;
  const tracking = answers.filter(a => /^(?:shipment )?tracking (?:ids?|numbers?)\s*[:*]?$/i.test(a.payment_head_questions?.question_text.trim() ?? ''));
  const ids = new Set(tracking.flatMap(a => (a.answer_value ?? '').split(/[\s,;]+/).filter(Boolean)));
  return ids.size || null;
}

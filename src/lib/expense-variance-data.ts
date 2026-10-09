import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expenseVariance, estimatedShipments, estimatedCps } from './expense-variance';
export type ExpenseVarianceRow = ReturnType<typeof expenseVariance> & { id: string; reference: string; date: string; station: string; stationId: string; head: string; headCode: string; status: string; shipments: number | null; cps: number | null };
export async function loadExpenseVariances(db: SupabaseClient, company: string, stations: Array<{ id: string; station_code: string }>, from: string, to: string): Promise<ExpenseVarianceRow[]> {
  if (!stations.length) return [];
  const byId = new Map(stations.map(s => [s.id, s.station_code]));
  const results: ExpenseVarianceRow[] = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const result = await db.from('payment_requests').select('id,request_no,work_date,location_id,amount_requested,amount,amount_approved,status,approval_status,payment_heads(code,name),payment_request_answers(answer_value,payment_head_questions(question_text))')
      .eq('company_id', company).in('location_id', stations.map(s => s.id)).gte('work_date', from).lte('work_date', to).order('work_date').order('id').range(offset, offset + 999);
    if (result.error) throw new Error('Expense comparison could not be loaded.');
    for (const record of result.data ?? []) {
      const head = Array.isArray(record.payment_heads) ? record.payment_heads[0] : record.payment_heads;
      const answers = (record.payment_request_answers ?? []).map(a => ({ ...a, payment_head_questions: Array.isArray(a.payment_head_questions) ? a.payment_head_questions[0] : a.payment_head_questions }));
      const shipments = estimatedShipments(answers);
      results.push({ ...expenseVariance(record), id: record.id, reference: record.request_no || record.id, date: record.work_date, stationId: record.location_id,
        station: byId.get(record.location_id) || '—', head: head?.name || 'Unknown head', headCode: head?.code || '', status: record.approval_status || record.status || 'Unknown', shipments, cps: estimatedCps(record.amount_requested, shipments) });
    }
    if ((result.data?.length ?? 0) < 1000) return results;
  }
  throw new Error('Select a shorter report range.');
}
export function expenseVarianceExport(rows: ExpenseVarianceRow[], storeOnly = false) {
  return rows.map(r => ({ Date: r.date, [storeOnly ? "Store" : "Station"]: r.station, Reference: r.reference, 'Payment head': r.head, Status: r.status, 'Estimated INR': r.estimated,
    'Actual submitted INR': r.actual, 'Difference INR': r.delta, 'Difference %': r.percent == null ? null : Number(r.percent.toFixed(2)), Attention: r.state, ...(storeOnly ? {} : { 'Estimated shipments': r.shipments, 'Estimated CPS': r.cps == null ? null : Number(r.cps.toFixed(2)) }) }));
}

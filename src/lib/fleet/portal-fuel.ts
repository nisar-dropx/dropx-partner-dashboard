import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { vanFuelDetails } from '@/lib/van-fuel';
import { paymentStatusLabel } from '@/lib/payment-status-label';
import { paymentRequestAttachments } from '@/lib/payment-request-attachments';

/** Derived from the original request, so approval retries and payment processing never duplicate fuel. */
export async function loadPortalFuel(company: string) {
  if (!supabaseAdmin) throw new Error('Station fuel requests unavailable.');
  const heads = await supabaseAdmin.from('payment_heads').select('id').eq('company_id', company).eq('code', 'VAN_FUEL');
  if (heads.error) throw new Error('Station fuel requests unavailable.');
  if (!heads.data?.length) return { approved: [], pending: [] };
  const requests = await readAllRows(supabaseAdmin.from('payment_requests').select('id,request_no,details,amount,amount_requested,status,approval_status,current_approver_user_id,current_approver_role_id,current_approver_role_ids,bank_status,utr_cin').eq('company_id', company).in('payment_head_id', heads.data.map(row => row.id)).not('details->van_fuel', 'is', null).order('id'));
  if (requests.error) throw new Error('Station fuel requests unavailable.');
  const rows = requests.data ?? [];
  const billRequests = new Set<string>();
  for (let i = 0; i < rows.length; i += 100) {
    const answers = await readAllRows(supabaseAdmin.from('payment_request_answers').select('id,payment_request_id,file_path,file_name,attachments').eq('company_id', company).in('payment_request_id', rows.slice(i, i + 100).map(row => row.id)).order('id'));
    if (answers.error) throw new Error('Unable to verify station fuel bills.');
    for (const answer of answers.data ?? []) if (paymentRequestAttachments(answer).length) billRequests.add(answer.payment_request_id);
  }
  const mapped = rows.flatMap(request => {
    const fuel = vanFuelDetails(request.details);
    const label = paymentStatusLabel(request);
    if (!fuel || ['Rejected', 'Cancelled'].includes(label) || ['rejected', 'cancelled', 'draft'].includes(String(request.status).toLowerCase())) return [];
    const approved = ['Final Approved', 'Processed', 'Processing', 'Paid', 'Resubmitted - Payment Processing'].includes(label);
    const ready = approved && Number(request.amount) > 0 && Number(fuel.litres) > 0 && billRequests.has(request.id);
    return [{ provider: 'Station bill', transaction_id: request.id, transaction_at: `${fuel.fuel_date}T00:00:00+05:30`, transaction_date: fuel.fuel_date, vehicle_no: fuel.vehicle_no, station_code: fuel.station_code, product: 'Fuel', station_name: request.request_no, station_location: fuel.station_code, fuel_quantity: Number(fuel.litres) || 0, fuel_amount: Number(request.amount ?? request.amount_requested) || 0, rate: fuel.litres ? Number(request.amount ?? request.amount_requested) / fuel.litres : 0, request_no: request.request_no, request_id: request.id, status: ready ? 'Approved' : approved ? 'Awaiting actual bill' : label, ready }];
  });
  return { approved: mapped.filter(row => row.ready), pending: mapped.filter(row => !row.ready) };
}

import { NextResponse } from 'next/server';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { paymentRequestFacts, paymentTrackingSearch } from '@/lib/payment-request-facts';
import { paymentStatusLabel } from '@/lib/payment-status-label';
import { hasSubmittedPaymentDetails } from '@/lib/payment-details';
import { paymentTrackingProgress } from '@/lib/payment-tracking-progress';
import { paymentRequestAttachments } from '@/lib/payment-request-attachments';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const relation = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] : value;

export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth) return json({ error: 'Login required.' }, 401);
    if (!['payment_approvals', 'payment_requests', 'expense_requests'].some(page => hasPermission(auth, page, 'access'))) return json({ error: 'Payment access required.' }, 403);
    const search = paymentTrackingSearch(new URL(request.url).searchParams.get('q') || '');
    if (!search) return json({ error: 'Enter a payment or request ID (up to 120 characters).' }, 400);
    if (!supabaseAdmin) return json({ error: 'Payment tracking is temporarily unavailable.' }, 503);
    const companyId = requireCompanyId(auth);
    const notFound = () => json({ error: 'No matching request in your permitted locations.' }, 404);
    if (!auth.hasAllLocationAccess && !auth.locationScopeIds.length) return notFound();
    const lookup = (column: string, value: string) => {
      let query = supabaseAdmin!.from('payment_requests').select('id,request_no,location_id,location_code,payment_heads(name),amount,amount_requested,created_at,requested_by,status,approval_status,current_approver_user_id,current_approver_role_id,current_approver_role_ids,current_step_order,total_steps,bank_status,utr_cin,processed_at,payment_mode,payment_portal,payment_reference,bank_account_no,ifsc,account_holder_name,remarks,requested_for_name,work_date,details,adhoc_da_name,adhoc_provider_employee_id,adhoc_work_date,delivery_performer_mode,delivery_identity_confirmed,delivery_performer_name,delivery_provider_employee_id,delivery_work_date,adhoc_vehicle_snapshot,adhoc_deployment_date').eq('company_id', companyId).eq(column, value);
      if (!auth.hasAllLocationAccess) query = query.in('location_id', auth.locationScopeIds);
      return query.limit(2);
    };
    const found = await lookup(search.column, search.column === 'request_no' ? search.query.toUpperCase() : search.query);
    if (found.error) throw found.error;
    if (!found.data?.length) return notFound();
    if (found.data.length > 1) return json({ error: 'This request number matches multiple records. Contact Finance.' }, 409);
    const row = found.data[0];
    const [logs, answers] = await Promise.all([
      supabaseAdmin.from('payment_request_approvals').select('id,action,comments,created_at,approver_user_id,approver_role_id').eq('company_id', companyId).eq('payment_request_id', row.id).order('created_at', { ascending: true }),
      supabaseAdmin.from('payment_request_answers').select('id,answer_value,file_path,file_name,file_size,attachments,payment_head_questions(question_text,field_stage)').eq('company_id', companyId).eq('payment_request_id', row.id)
    ]);
    if (logs.error || answers.error) throw logs.error || answers.error;
    const userIds = [...new Set([row.requested_by, row.current_approver_user_id, ...(logs.data || []).map(log => log.approver_user_id)].filter((id): id is string => Boolean(id)))];
    const roleIds = [...new Set([row.current_approver_role_id, ...(row.current_approver_role_ids || []), ...(logs.data || []).map(log => log.approver_role_id)].filter((id): id is string => Boolean(id)))];
    const [users, roles] = await Promise.all([
      userIds.length ? supabaseAdmin.from('profiles').select('id,full_name').eq('company_id', companyId).in('id', userIds) : Promise.resolve({ data: [], error: null }),
      roleIds.length ? supabaseAdmin.from('user_roles').select('id,name,code').eq('company_id', companyId).in('id', roleIds) : Promise.resolve({ data: [], error: null })
    ]);
    if (users.error || roles.error) throw users.error || roles.error;
    const names = new Map((users.data || []).map(user => [user.id, user.full_name || 'User']));
    const roleNames = new Map((roles.data || []).map(role => [role.id, role.name || role.code]));
    const status = paymentStatusLabel(row);
    const owner = row.current_approver_user_id ? names.get(row.current_approver_user_id) || 'Assigned approver' : (row.current_approver_role_ids?.length ? row.current_approver_role_ids : [row.current_approver_role_id]).map((id: string) => roleNames.get(id)).filter(Boolean).join(' / ');
    return json({
      requestNo: row.request_no, location: row.location_code, head: relation(row.payment_heads)?.name || 'Payment',
      amount: row.amount ?? row.amount_requested, status,
      owner,
      progress: paymentTrackingProgress({ status, detailsSubmitted: hasSubmittedPaymentDetails(row), owner, step: row.current_step_order, totalSteps: row.total_steps }),
      reference: row.utr_cin || null,
      facts: paymentRequestFacts(row),
      answers: (answers.data || []).map(answer => ({
        id: answer.id, label: relation(answer.payment_head_questions)?.question_text || 'Field',
        stage: relation(answer.payment_head_questions)?.field_stage === 'payment' ? 'Payment details' : 'Expense details',
        value: answer.answer_value,
        attachments: paymentRequestAttachments(answer).map((file, index) => ({ name: file.name, url: `/api/payments/requests/attachment?answer_id=${encodeURIComponent(answer.id)}&attachment_index=${index}` }))
      })),
      events: [
        { id: 'requested', action: 'Requested', actor: names.get(row.requested_by) || 'Requester', role: '', at: row.created_at, note: null },
        ...(logs.data || []).map(log => ({ id: log.id, action: (log.action || 'Updated').replaceAll('_', ' '), actor: log.approver_user_id ? names.get(log.approver_user_id) || 'User' : 'System', role: roleNames.get(log.approver_role_id) || '', at: log.created_at, note: log.comments })),
        ...(status === 'Paid' && row.processed_at ? [{ id: 'bank-paid', action: 'Paid', actor: 'Payment confirmed', role: '', at: row.processed_at, note: row.utr_cin ? `Bank reference: ${row.utr_cin}` : null }] : [])
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    });
  } catch (error) {
    console.error('Payment tracking lookup failed', error);
    return json({ error: 'Unable to load payment history. Please retry.' }, 500);
  }
}

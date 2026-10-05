import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessPaymentLocation, getPaymentApprovalEligibility } from '@/lib/payment-approval-scope';
import { isPaymentTrackingQuestion, parsePaymentTrackingIds } from '@/lib/payment-shipment-count';
import { loadPaymentShipmentEvidence } from '@/lib/payment-shipment-evidence-data';
import { optionalPaymentEvidence } from '@/lib/optional-payment-evidence';

export const dynamic = 'force-dynamic';
const first = <T,>(value: T | T[] | null): T | null => Array.isArray(value) ? value[0] ?? null : value;
export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth) return Response.json({error: 'Login required'}, {status: 401});
    if (!hasPermission(auth, 'payment_approvals', 'access')) return Response.json({error: 'Access denied'}, {status: 403});
    const id = new URL(request.url).searchParams.get('request') ?? '';
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return Response.json({error: 'Invalid request'}, {status: 400});
    if (!supabaseAdmin) return Response.json({error: 'Details unavailable'}, {status: 503});
    const company = requireCompanyId(auth);
    const result = await supabaseAdmin.from('payment_requests')
      .select('id,location_id,location_code,requested_by,current_approver_user_id,current_approver_role_id,current_approver_role_ids,stations(location_model_id),payment_heads(code)')
      .eq('company_id', company).eq('id', id).maybeSingle();
    const payment = result.data;
    if (result.error || !payment) return Response.json({error: 'Request unavailable'}, {status: 404});
    if (!canAccessPaymentLocation(auth, payment.location_id)) return Response.json({error: 'Access denied'}, {status: 403});
    const eligible = await getPaymentApprovalEligibility(company, auth, [{...payment, location_model_id: first(payment.stations)?.location_model_id ?? null}]);
    if (!eligible.has(id)) return Response.json({error: 'Access denied'}, {status: 403});
    if (first(payment.payment_heads)?.code !== 'VAN_ADHOC') return Response.json({error: 'No shipment evidence'}, {status: 404});
    const answers = await supabaseAdmin.from('payment_request_answers').select('answer_value,payment_head_questions(question_text,answer_type)').eq('company_id', company).eq('payment_request_id', id);
    if (answers.error) throw new Error('Answers unavailable');
    const ids = [...new Set((answers.data ?? []).filter(answer => isPaymentTrackingQuestion(first(answer.payment_head_questions))).flatMap(answer => parsePaymentTrackingIds(answer.answer_value ?? '')))];
    const evidence = await optionalPaymentEvidence(() => loadPaymentShipmentEvidence(company, payment.location_code, ids));
    if (!evidence.data) throw new Error('Details unavailable');
    return Response.json(evidence.data, {headers: {'Cache-Control': 'private, no-store'}});
  } catch {
    return Response.json({error: 'Shipment details unavailable. You can continue reviewing.'}, {status: 503});
  }
}

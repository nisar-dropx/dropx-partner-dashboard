import 'server-only';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessPaymentLocation, getPaymentApprovalEligibility } from '@/lib/payment-approval-scope';

const first = <T,>(value: T | T[] | null): T | null => Array.isArray(value) ? value[0] ?? null : value;
export async function authorizePaymentEvidence(request: Request) {
    const auth = await getAuthorization();
    if (!auth) return { error: Response.json({error: 'Login required'}, {status: 401}) };
    if (!hasPermission(auth, 'payment_approvals', 'access')) return { error: Response.json({error: 'Access denied'}, {status: 403}) };
    const id = new URL(request.url).searchParams.get('request') ?? '';
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return { error: Response.json({error: 'Invalid request'}, {status: 400}) };
    if (!supabaseAdmin) return { error: Response.json({error: 'Details unavailable'}, {status: 503}) };
    const company = requireCompanyId(auth);
    const result = await supabaseAdmin.from('payment_requests')
      .select('id,location_id,location_code,requested_by,current_approver_user_id,current_approver_role_id,current_approver_role_ids,stations(location_model_id),payment_heads(code)')
      .eq('company_id', company).eq('id', id).maybeSingle();
    const payment = result.data;
    if (result.error || !payment) return { error: Response.json({error: 'Request unavailable'}, {status: 404}) };
    if (!canAccessPaymentLocation(auth, payment.location_id)) return { error: Response.json({error: 'Access denied'}, {status: 403}) };
    const eligible = await getPaymentApprovalEligibility(company, auth, [{...payment, location_model_id: first(payment.stations)?.location_model_id ?? null}]);
    if (!eligible.has(id)) return { error: Response.json({error: 'Access denied'}, {status: 403}) };
    if (first(payment.payment_heads)?.code !== 'VAN_ADHOC') return { error: Response.json({error: 'No shipment evidence'}, {status: 404}) };
    return { company, payment };
}

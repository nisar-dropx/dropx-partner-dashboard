import { authorizePaymentEvidence } from '@/lib/payment-evidence-authorization';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isPaymentTrackingQuestion, parsePaymentTrackingIds } from '@/lib/payment-shipment-count';
import { loadPaymentShipmentEvidence } from '@/lib/payment-shipment-evidence-data';
import { optionalPaymentEvidence } from '@/lib/optional-payment-evidence';

export const dynamic = 'force-dynamic';
const first = <T,>(value: T | T[] | null): T | null => Array.isArray(value) ? value[0] ?? null : value;
export async function GET(request: Request) {
  try {
    const authorized = await authorizePaymentEvidence(request);
    if ('error' in authorized) return authorized.error;
    const { company, payment } = authorized;
    const id = payment.id;
    const answers = await supabaseAdmin!.from('payment_request_answers').select('answer_value,payment_head_questions(question_text,answer_type)').eq('company_id', company).eq('payment_request_id', id);
    if (answers.error) throw new Error('Answers unavailable');
    const ids = [...new Set((answers.data ?? []).filter(answer => isPaymentTrackingQuestion(first(answer.payment_head_questions))).flatMap(answer => parsePaymentTrackingIds(answer.answer_value ?? '')))];
    const evidence = await optionalPaymentEvidence(() => loadPaymentShipmentEvidence(company, payment.location_code, ids));
    if (!evidence.data) throw new Error('Details unavailable');
    return Response.json(evidence.data, {headers: {'Cache-Control': 'private, no-store'}});
  } catch {
    return Response.json({error: 'Shipment details unavailable. You can continue reviewing.'}, {status: 503});
  }
}

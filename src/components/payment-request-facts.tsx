import type { PaymentRequestFact } from '@/lib/payment-request-facts';

import { PaymentDetailValue, isLongPaymentDetail } from '@/components/payment-detail-value';
export function PaymentRequestFacts({ facts }: { facts: PaymentRequestFact[] }) {
  if (!facts.length) return null;
  return <section className="payment-request-facts"><strong>Latest submitted details</strong><dl>{facts.map(fact => <div key={fact.label} className={isLongPaymentDetail(fact.value) ? "payment-detail-wide" : undefined}><dt>{fact.label}</dt><dd><PaymentDetailValue value={fact.value} label={fact.label} /></dd></div>)}</dl></section>;
}

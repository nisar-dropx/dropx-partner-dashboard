import type { PaymentRequestFact } from '@/lib/payment-request-facts';

export function PaymentRequestFacts({ facts }: { facts: PaymentRequestFact[] }) {
  if (!facts.length) return null;
  return <section className="payment-request-facts"><strong>Latest submitted details</strong><dl>{facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl></section>;
}

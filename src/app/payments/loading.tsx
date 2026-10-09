export default function PaymentLoading() {
  return <section className="panel" style={{ padding: 24, margin: 24 }} role="status" aria-live="polite">
    <span className="inline-spinner" aria-hidden="true" /> Loading payments…
  </section>;
}

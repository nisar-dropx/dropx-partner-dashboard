"use client";

export default function PaymentError({ reset }: { reset: () => void }) {
  return <section className="panel" style={{ margin: "32px auto", padding: 24, maxWidth: 640 }} role="alert">
    <h1>Payments could not load right now</h1>
    <p>Your session has not been cleared. Please retry when the connection is available.</p>
    <p>If this happened after a decision, check the request status before submitting it again.</p>
    <button type="button" className="button" onClick={reset}>Retry payments</button>
    <a className="button secondary" href="/payments/approvals">Open approval queue</a>
  </section>;
}

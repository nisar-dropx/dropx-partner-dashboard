"use client";

export default function WorkforcePayoutError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <section role="alert" style={{ padding: 24, maxWidth: 600 }}>
    <h2>Payout details could not load</h2>
    <p>Retry to load the latest worksheet. If this keeps happening on a closed month, narrow the location scope first, then open the month again.</p>
    {error?.digest ? <p className="subtle">Reference: {error.digest}</p> : null}
    <button className="button primary" type="button" onClick={reset}>Retry loading</button>
  </section>;
}

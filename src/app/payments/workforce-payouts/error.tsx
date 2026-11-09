"use client";

export default function WorkforcePayoutError({reset}:{reset:()=>void}) {
  return <section role="alert" style={{padding:24,maxWidth:600}}>
    <h2>Payout details could not load</h2>
    <p>Retry to load the latest worksheet.</p>
    <button className="button primary" type="button" onClick={reset}>Retry loading</button>
  </section>;
}

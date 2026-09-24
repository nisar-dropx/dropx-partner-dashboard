/** Shared, high-contrast OpsPulse identity for web and mobile surfaces. */
export function OpsPulseBrand() {
  return (
    <div className="ops-brand-lockup" role="img" aria-label="OpsPulse — Operations intelligence">
      <img className="ops-brand-mark" src="/opspulse/mark.svg?v=2" width={28} height={28} alt="" />
      <span className="ops-brand-copy">
        <strong>Ops<span>Pulse</span></strong>
        <small>Operations intelligence</small>
      </span>
    </div>
  );
}

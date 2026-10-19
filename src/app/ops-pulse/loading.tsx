export default function OpsPulseLoading() {
  return <div className="ops-route-loading" role="status" aria-live="polite">
    <img src="/opspulse/icon-192.png?v=2" width="56" height="56" alt="" />
    <strong>Opening your workspace</strong>
    <span>Loading OpsPulse…</span>
    <i className="page-spinner" aria-hidden="true" />
  </div>;
}

// Mirrors src/components/capacity-workspace-loading.tsx's pattern (a
// skeleton shaped like the real page, using the same pulsing
// capacity-loading-* placeholder classes) instead of a full-page text cover,
// so switching into CPS reads as "this page loading in" rather than the
// whole app reloading.
export function CpsWorkspaceLoading() {
  return <div className="ops-command-center cps-workspace capacity-loading-view" aria-live="polite" aria-busy="true">
    <div className="capacity-loading-title"><span /><span /></div>
    <nav className="cps-tabs capacity-loading-tabs" aria-hidden="true"><i /><i /><i /><i /></nav>
    <div className="cps-period">
      <strong className="capacity-loading-line" style={{ width: 220 }} />
      <span className="capacity-loading-line" style={{ width: 140 }} />
    </div>
    <section className="cps-kpis">
      {[0, 1, 2, 3, 4].map((item) => <article key={item}><span className="capacity-loading-line" /><strong className="capacity-loading-line" /></article>)}
    </section>
    <section className="panel"><div className="panel-head"><div className="capacity-loading-line" /></div>
      <div className="capacity-loading-rows">{[0, 1, 2, 3, 4, 5].map((item) => <span key={item} />)}</div>
    </section>
  </div>;
}

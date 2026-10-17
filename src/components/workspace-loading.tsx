/**
 * The site's standard loading skeleton (same capacity-loading classes as Workforce Payouts): a title,
 * summary tiles, a filter bar and list rows. Used by route loading.tsx files so every page loads alike.
 */
export function WorkspaceLoading({ label, tiles = 4, rows = 6, side = false }: { label: string; tiles?: number; rows?: number; side?: boolean }) {
  return (
    <main style={{ padding: "24px" }}>
      <div className="capacity-loading-view" aria-busy="true" aria-live="polite" aria-label={label} style={{ display: "grid", gap: 14 }}>
        <div className="capacity-loading-title" aria-hidden="true"><span /><span /></div>
        {tiles ? (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${tiles}, minmax(0, 1fr))`, gap: 10 }} aria-hidden="true">
            {Array.from({ length: tiles }, (_, i) => <span key={i} className="capacity-loading-line" style={{ height: 72, width: "100%" }} />)}
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: side ? "minmax(260px, 340px) 1fr" : "1fr", gap: 14 }} aria-hidden="true">
          {side ? <span className="capacity-loading-line" style={{ height: 360, width: "100%" }} /> : null}
          <section className="panel" style={{ display: "grid", gap: 10, padding: "14px 16px" }}>
            <span className="capacity-loading-line" style={{ height: 34, maxWidth: 560, width: "60%" }} />
            {Array.from({ length: rows }, (_, i) => <span key={i} className="capacity-loading-line" style={{ height: 52, width: "100%" }} />)}
          </section>
        </div>
      </div>
    </main>
  );
}

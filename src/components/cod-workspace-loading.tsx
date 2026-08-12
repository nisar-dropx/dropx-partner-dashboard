export function CodWorkspaceLoading({
  title = "Loading COD workspace",
  subtitle = "Preparing filters and live data…"
}: {
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className="cod-loading-view" aria-busy="true" aria-live="polite">
      <div className="cod-loading-head">
        <span className="cod-loading-eyebrow" />
        <span className="cod-loading-title" />
        <span className="cod-loading-subtitle" />
        <p className="cod-loading-status">{title}</p>
        <p className="subtle cod-loading-hint">{subtitle}</p>
      </div>

      <section className="panel cod-loading-panel" aria-hidden="true">
        <div className="panel-body">
          <div className="cod-loading-filters">
            <span /><span /><span /><span />
          </div>
        </div>
      </section>

      <section className="summary-grid cod-loading-metrics" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => (
          <div className="metric-card" key={item}>
            <span className="cod-loading-line short" />
            <strong className="cod-loading-line value" />
            <small className="cod-loading-line tiny" />
          </div>
        ))}
      </section>

      <section className="panel cod-loading-panel" aria-hidden="true">
        <div className="panel-head">
          <div className="cod-loading-line medium" />
          <span className="cod-loading-badge" />
        </div>
        <div className="cod-loading-rows">
          {[0, 1, 2, 3, 4, 5, 6].map((item) => (
            <span key={item} />
          ))}
        </div>
      </section>
    </div>
  );
}

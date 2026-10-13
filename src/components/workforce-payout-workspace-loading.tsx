const filterSkeletons = [0, 1, 2, 3, 4, 5];
const rowSkeletons = [0, 1, 2, 3, 4, 5, 6];

export function WorkforcePayoutWorkspaceLoading({
  periodTitle = "Loading payout worksheet"
}: {
  periodTitle?: string;
}) {
  return (
    <div
      className="workforce-payout-page capacity-loading-view"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading workforce payouts"
    >
      <div className="payout-page-titlebar">
        <div className="capacity-loading-title" aria-hidden="true">
          <span />
          <span />
        </div>
        <div className="performance-tabs capacity-loading-tabs" aria-hidden="true">
          <i />
          <i />
        </div>
      </div>

      <section className="panel">
        <div className="panel-head payout-period-head">
          <h2>{periodTitle}</h2>
          <span
            className="capacity-loading-line"
            aria-hidden="true"
            style={{ height: 34, maxWidth: 360, width: "45%" }}
          />
        </div>

        <div style={{ display: "grid", gap: 10, padding: "10px 12px" }} aria-hidden="true">
          <span className="capacity-loading-line" style={{ height: 34, maxWidth: 520, width: "42%" }} />
          <div
            style={{
              display: "grid",
              gap: 8,
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))"
            }}
          >
            {filterSkeletons.map((item) => (
              <span
                className="capacity-loading-line"
                key={item}
                style={{ height: 42, width: "100%" }}
              />
            ))}
          </div>
        </div>

        <div className="capacity-loading-rows" aria-hidden="true">
          {rowSkeletons.map((item) => <span key={item} />)}
        </div>
        <p className="subtle" style={{ margin: "0 16px 14px" }}>
          Loading the latest payout values and payment status…
        </p>
      </section>
    </div>
  );
}

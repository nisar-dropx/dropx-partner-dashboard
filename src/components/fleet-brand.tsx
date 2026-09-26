export function FleetBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`fleet-brand-lockup ${compact ? "compact" : ""}`} aria-label="DropX Fleet — Vehicle operations">
      <img className="fleet-parent-logo" src="/dropx-logo.png" alt="DropX" />
      <span className="fleet-brand-divider" aria-hidden="true" />
      <span className="fleet-product-brand">
        <img src="/fleet-control/mark.svg" width={compact ? 29 : 38} height={compact ? 29 : 38} alt="" />
        <span><strong>Fleet</strong><small>Vehicle operations</small></span>
      </span>
    </div>
  );
}

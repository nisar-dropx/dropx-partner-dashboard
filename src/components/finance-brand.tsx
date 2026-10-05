export function FinanceBrand({ compact = false }: { compact?: boolean }) {
  return <span className={`finance-brand${compact ? " compact" : ""}`}>
    <img src="/finance-app/mark.svg" width="40" height="40" alt="" />
    <span><strong>Finance<span className="finance-brand-dot">.</span></strong><small>BY DROPX</small></span>
  </span>;
}

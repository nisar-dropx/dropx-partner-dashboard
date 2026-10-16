import { payoutChecks, type PayoutCheckRow } from "@/lib/workforce-payout-checks";
import styles from "./workforce-payout-checks.module.css";

const inr = (n: number) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/** Compact pre-payment cross-check strip; expands to the flagged people. Server-rendered from loaded rows. */
export function WorkforcePayoutChecks({ rows }: { rows: PayoutCheckRow[] }) {
  const s = payoutChecks(rows);
  if (!s.checked) return null;
  if (!s.flagged)
    return <div className={`${styles.strip} ${styles.clear}`}><strong>Pre-payment checks passed</strong><span>{s.checked} payouts agree with attendance, review and bank details.</span></div>;
  return (
    <details className={`${styles.strip} ${s.critical ? styles.critical : styles.review}`}>
      <summary>
        <strong>{s.flagged} of {s.checked} payouts need a look before paying</strong>
        <span>{inr(s.flaggedAmount)} net pay flagged</span>
        <span className={styles.chips}>{s.groups.map((g) => <em key={g.code} className={g.severity === "critical" ? styles.chipCritical : styles.chip}>{g.label} · {g.rows.length}</em>)}</span>
      </summary>
      <div className={styles.groups}>
        {s.groups.map((g) => (
          <section key={g.code}>
            <h3>{g.label} <small>{g.help}</small></h3>
            <table>
              <thead><tr><th>Associate</th><th>Station</th><th>Days</th><th>Gross</th><th>Deductions</th><th>Net</th><th>Reviewed</th></tr></thead>
              <tbody>
                {g.rows.slice(0, 50).map((r) => (
                  <tr key={r.id}><td>{r.name} <small>{r.dropxId}</small></td><td>{r.location}</td><td>{r.workDays}</td><td>{inr(r.grossPayment)}</td><td>{inr(r.deductions)}</td><td><b>{inr(r.netAmount)}</b></td><td>{r.publicationTargetAmount == null ? "—" : inr(r.publicationTargetAmount)}</td></tr>
                ))}
              </tbody>
            </table>
            {g.rows.length > 50 ? <p>{g.rows.length - 50} more — filter the table below.</p> : null}
          </section>
        ))}
      </div>
    </details>
  );
}

import Link from "next/link";
import styles from "./cod-cash-position.module.css";

const inr = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));

export type CodCashPositionData = {
  collected: number;
  pendingAmount: number;
  pendingDays: number;
  deposited: number;
  verifiedAmount: number;
  issueAmount: number;
  issueCount: number;
  notStarted: number;
  focusDateLabel: string;
};

/** The cash position at a glance: where collected COD sits now, as money, with the next action for each stage. */
export function CodCashPosition({ data }: { data: CodCashPositionData }) {
  const gap = Math.round(data.deposited - data.collected);
  const base = Math.max(data.collected, data.deposited, 1);
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / base) * 100)).toFixed(1)}%`;
  const stages = [
    { label: "Collected (ER)", value: data.collected, hint: "Final-submitted executive reconciliation", tone: styles.neutral },
    { label: "Awaiting deposit", value: data.pendingAmount, hint: data.pendingDays ? `${data.pendingDays} station-day${data.pendingDays === 1 ? "" : "s"} without a slip` : "Every closed day has a slip", tone: data.pendingDays ? styles.warn : styles.good, href: data.pendingDays ? "#pending-cod" : undefined },
    { label: "Deposited", value: data.deposited, hint: "Slips filed by stations", tone: styles.neutral },
    { label: "Verified", value: data.verifiedAmount, hint: "Matched with the portal", tone: styles.good },
    { label: "Issues", value: data.issueAmount, hint: data.issueCount ? `${data.issueCount} short / excess / rejected` : "No mismatches", tone: data.issueCount ? styles.bad : styles.good },
  ];
  return (
    <section className={styles.wrap} aria-label="Cash position">
      <div className={styles.head}>
        <strong>Cash position</strong>
        <span className={gap === 0 ? styles.ok : styles.alert}>
          {gap === 0 ? "Deposits match collections" : gap < 0 ? `${inr(-gap)} collected but not yet deposited` : `${inr(gap)} more deposited than collected`}
        </span>
        {data.notStarted ? <Link href="#station-status" className={styles.alert}>{data.notStarted} station{data.notStarted === 1 ? "" : "s"} not started for {data.focusDateLabel}</Link> : null}
      </div>
      <div className={styles.bar} aria-hidden>
        <span className={styles.barVerified} style={{ width: pct(data.verifiedAmount) }} />
        <span className={styles.barDeposited} style={{ width: pct(Math.max(0, data.deposited - data.verifiedAmount)) }} />
        <span className={styles.barPending} style={{ width: pct(data.pendingAmount) }} />
      </div>
      <div className={styles.stages}>
        {stages.map((s) => {
          const body = (
            <>
              <span>{s.label}</span>
              <strong>{inr(s.value)}</strong>
              <small>{s.hint}</small>
            </>
          );
          return s.href ? <a key={s.label} href={s.href} className={`${styles.stage} ${s.tone}`}>{body}</a> : <div key={s.label} className={`${styles.stage} ${s.tone}`}>{body}</div>;
        })}
      </div>
    </section>
  );
}

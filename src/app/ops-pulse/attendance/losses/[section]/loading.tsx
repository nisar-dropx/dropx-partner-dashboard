import styles from "@/components/ops-loss-report.module.css";

/** Shown instantly while a Losses tab or station loads (client navigation keeps the shell). */
export default function Loading() {
  return <div className={styles.workspace} aria-busy="true" aria-label="Loading losses">
    <div className={styles.skeleton} style={{ height: 64, maxWidth: 520 }} />
    <div className={styles.metrics}>{[0, 1, 2, 3].map((i) => <div key={i} className={styles.skeleton} style={{ height: 104 }} />)}</div>
    <div className={styles.skeleton} style={{ height: 320 }} />
  </div>;
}

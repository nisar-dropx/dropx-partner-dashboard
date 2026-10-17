import Link from "next/link";
import { LossTidSearch } from "./loss-tid-search";
import styles from "./loss-header.module.css";

export type LossTab = { key: string; label: string; href: string };

export function LossTabs({ tabs, active }: { tabs: LossTab[]; active: string }) {
  return (
    <nav className={styles.tabs} aria-label="Loss reports">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} prefetch className={`${styles.tab} ${t.key === active ? styles.activeTab : ""}`} aria-current={t.key === active ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The one header every Team Ops → Losses tab uses, so switching tabs never moves the title, the
 * tracking-ID search or the tab bar. The tabs sit on their own full-width row.
 */
export function LossHeader({ eyebrow = "Team Ops · Losses", title, intro, tabs, active }: { eyebrow?: string; title: string; intro: string; tabs: LossTab[]; active: string }) {
  return (
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1>{title}</h1>
          <p title={intro}>{intro}</p>
        </div>
        <div className={styles.search}><LossTidSearch /></div>
      </div>
      <LossTabs tabs={tabs} active={active} />
    </header>
  );
}

import Link from "next/link";
import { pageWindow, PAGE_SIZES } from "@/lib/page-window";
import styles from "./list-pager.module.css";

/** Parse ?page= and ?size= (allowed sizes only). */
export function readPaging(page: string | undefined, size: string | undefined, fallback = 50) {
  const s = PAGE_SIZES.find((n) => String(n) === size) ?? fallback;
  return { page: Math.max(1, Number.parseInt(page ?? "1", 10) || 1), size: s };
}

/** Server pager: links keep every other filter; rows-per-page is a tiny GET form. */
export function UrlPager({ basePath, params, total, page, size, pageKey = "page", sizeKey = "size", label = "rows" }: {
  basePath: string; params: Record<string, string | undefined>; total: number; page: number; size: number; pageKey?: string; sizeKey?: string; label?: string;
}) {
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages);
  const href = (n: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    q.set(pageKey, String(n));
    q.set(sizeKey, String(size));
    return `${basePath}?${q}`;
  };
  const from = (current - 1) * size + 1, to = Math.min(total, current * size);
  return (
    <nav className={styles.pager} aria-label="Pages">
      <span className={styles.count}>{from}–{to} of {total.toLocaleString("en-IN")} {label}</span>
      <form method="get" action={basePath} className={styles.size}>
        {Object.entries(params).filter(([k, v]) => v && k !== pageKey && k !== sizeKey).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <label>Rows per page
          <select name={sizeKey} defaultValue={String(size)}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <button className={styles.apply}>Apply</button>
      </form>
      {pages > 1 ? (
        <span className={styles.pages}>
          {current > 1 ? <Link href={href(current - 1)} prefetch={false} aria-label="Previous page">‹</Link> : <span className={styles.off}>‹</span>}
          {pageWindow(current, pages).map((n, i) => n === "…" ? <span key={`g${i}`} className={styles.gap}>…</span> : (
            <Link key={n} href={href(n)} prefetch={false} aria-current={n === current ? "page" : undefined} className={n === current ? styles.on : undefined}>{n}</Link>
          ))}
          {current < pages ? <Link href={href(current + 1)} prefetch={false} aria-label="Next page">›</Link> : <span className={styles.off}>›</span>}
        </span>
      ) : null}
    </nav>
  );
}

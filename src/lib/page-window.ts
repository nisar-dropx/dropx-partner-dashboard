/** Shared paging helpers for every list and report. */
export const PAGE_SIZES = [25, 50, 100] as const;

/** Page numbers to show: first, last, and a window around the current page, with gaps. */
export function pageWindow(current: number, pages: number): Array<number | "…"> {
  const keep = new Set([1, pages, current - 1, current, current + 1].filter((n) => n >= 1 && n <= pages));
  const out: Array<number | "…"> = [];
  let last = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - last > 1) out.push("…");
    out.push(n);
    last = n;
  }
  return out;
}

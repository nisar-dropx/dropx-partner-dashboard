import type { NavItem } from "../app-navigation";

/** Only search the permission-filtered navigation passed by AppShell. */
export function searchOpsNavigation(items: NavItem[], query: string): NavItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  const matches = (label: string) => terms.every(term => label.toLowerCase().includes(term));
  return items.flatMap(item => {
    if (matches(item.label)) return [item];
    const children = item.children?.filter(child => matches(`${item.label} ${child.label}`));
    return children?.length ? [{ ...item, children }] : [];
  });
}

/** Prefer the most specific route, including query-based Fleet/Performance tabs. */
export function activeOpsHref(items: NavItem[], pathname: string, search: string, active: string): string | undefined {
  const current = new URLSearchParams(search);
  const links = items.flatMap<Pick<NavItem, "href" | "label">>(item => item.children ?? [item]);
  const ranked = links.flatMap(item => {
    if (!item.href?.startsWith("/")) return [];
    const url = new URL(item.href, "https://ops.local");
    if (pathname !== url.pathname && !(url.pathname !== "/" && pathname.startsWith(`${url.pathname}/`))) return [];
    const entries = Array.from(url.searchParams.entries());
    if (!entries.every(([key, value]) => current.get(key) === value)) return [];
    return [{ href: item.href, rank: url.pathname.length * 100 + entries.length }];
  }).sort((a, b) => b.rank - a.rank);
  const activeGroup = items.find(item => item.label === active);
  const defaultTab = activeGroup?.children?.find(child => child.href && new URL(child.href, "https://ops.local").pathname === pathname);
  return ranked[0]?.href ?? links.find(item => item.label === active)?.href ?? defaultTab?.href;
}

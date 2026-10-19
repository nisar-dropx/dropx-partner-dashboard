import type { NavItem } from "../app-navigation";

export type PermissionPage = { id: string; code: string; name: string };
export type PermissionNavigationView = { key: string; label: string; items: NavItem[] };
export type PermissionMenuRow = { key: string; label: string; page: PermissionPage; sharedWith: string[] };
export type PermissionMenuGroup = { key: string; label: string; rows: PermissionMenuRow[]; expandable: boolean };

/** Read the same menu tree as the sidebar; permission IDs still come from app_pages. */
export function permissionMenuGroups(pages: PermissionPage[], items: NavItem[], views: PermissionNavigationView[]): PermissionMenuGroup[] {
  const byCode = new Map(pages.map(page => [page.code, page]));
  const labels = new Map<string, Set<string>>();
  for (const view of views) for (const item of view.items) {
    for (const link of item.children?.length ? item.children : [item]) {
      if (!link.code) continue;
      const values = labels.get(link.code) ?? new Set<string>();
      values.add(link.label); labels.set(link.code, values);
    }
  }
  return items.flatMap(item => {
    const rows: PermissionMenuRow[] = [];
    const append = (code: string | undefined, label: string, key: string) => {
      const page = code ? byCode.get(code) : undefined;
      if (page) rows.push({key, label, page, sharedWith: [...(labels.get(page.code) ?? [])].filter(value => value !== label)});
    };
    if (item.children?.length) {
      for (const [index, child] of item.children.entries()) append(child.code, child.label, `${item.code}:${index}`);
      const childCodes = new Set(item.children.map(child => child.code));
      // Preserve broad/legacy menu grants and non-menu actions without inventing new grants.
      for (const code of [item.code, ...(item.permissionCodes ?? [])]) {
        if (childCodes.has(code) || rows.some(row => row.page.code === code)) continue;
        const page = byCode.get(code);
        if (page) append(code, page.name, `${item.code}:action:${code}`);
      }
    } else append(item.code, item.label, item.code);
    return rows.length ? [{key: item.code, label: item.label, rows, expandable: Boolean(item.children?.length) || rows.length > 1}] : [];
  });
}

export function filterPermissionMenus(groups: PermissionMenuGroup[], search: string): PermissionMenuGroup[] {
  const term = search.trim().toLowerCase();
  if (!term) return groups;
  return groups.flatMap(group => {
    const rows = group.label.toLowerCase().includes(term) ? group.rows : group.rows.filter(row => `${row.label} ${row.page.name}`.toLowerCase().includes(term));
    return rows.length ? [{...group, rows}] : [];
  });
}

export function menuPermissionIds(groups: PermissionMenuGroup[]): string[] {
  return [...new Set(groups.flatMap(group => group.rows.map(row => row.page.id)))];
}

export function additionalPermissionPages(pages: PermissionPage[], views: PermissionNavigationView[]): PermissionPage[] {
  const represented = new Set(views.flatMap(view => menuPermissionIds(permissionMenuGroups(pages, view.items, views))));
  return pages.filter(page => !represented.has(page.id));
}

import type { NavItem } from "../app-navigation";

export type PermissionPage = { id: string; code: string; name: string };
export type PermissionNavigationView = { key: string; label: string; items: NavItem[] };
export type PermissionLeafRow = { key: string; label: string; page: PermissionPage; sharedWith: string[] };
export type PermissionMenuRow = {
  key: string;
  label: string;
  /** Legacy or structural page represented by this row but not directly granted. */
  structuralPage?: PermissionPage;
  /** Empty for a normal leaf. Multiple entries represent independently grantable in-page sections. */
  sections: PermissionLeafRow[];
  page?: PermissionPage;
  sharedWith: string[];
};
export type PermissionMenuGroup = { key: string; label: string; rows: PermissionMenuRow[]; expandable: boolean };

/** Read the same menu tree as the sidebar; permission IDs still come from app_pages. */
export function permissionMenuGroups(pages: PermissionPage[], items: NavItem[], views: PermissionNavigationView[]): PermissionMenuGroup[] {
  const byCode = new Map(pages.map(page => [page.code, page]));
  const labels = new Map<string, Set<string>>();
  for (const view of views) for (const item of view.items) {
    for (const link of item.children?.length ? item.children : [item]) {
      const permissionLinks = link.permissionSections?.length ? link.permissionSections : [link];
      for (const permissionLink of permissionLinks) {
        if (!permissionLink.code) continue;
        const values = labels.get(permissionLink.code) ?? new Set<string>();
        values.add(permissionLink.label); labels.set(permissionLink.code, values);
      }
    }
  }
  return items.flatMap(item => {
    const rows: PermissionMenuRow[] = [];
    const leaf = (code: string | undefined, label: string, key: string): PermissionLeafRow | null => {
      const page = code ? byCode.get(code) : undefined;
      return page ? {key, label, page, sharedWith: [...(labels.get(page.code) ?? [])].filter(value => value !== label)} : null;
    };
    const append = (code: string | undefined, label: string, key: string) => {
      const entry = leaf(code, label, key);
      if (entry) rows.push({...entry, sections: []});
    };
    if (item.children?.length) {
      for (const [index, child] of item.children.entries()) {
        const key = `${item.code}:${index}`;
        if (child.permissionSections?.length) {
          const sections = child.permissionSections
            .map((section, sectionIndex) => leaf(section.code, section.label, `${key}:section:${sectionIndex}`))
            .filter((section): section is PermissionLeafRow => Boolean(section));
          if (sections.length) rows.push({
            key,
            label: child.label,
            structuralPage: child.code ? byCode.get(child.code) : undefined,
            sections,
            sharedWith: [],
          });
        } else append(child.code, child.label, key);
      }
      const childCodes = new Set(item.children.flatMap(child => [child.code, ...(child.permissionSections ?? []).map(section => section.code)]));
      // Preserve broad/legacy menu grants and non-menu actions without inventing new grants.
      for (const code of [item.code, ...(item.permissionCodes ?? [])]) {
        if (childCodes.has(code) || rows.some(row => row.page?.code === code || row.sections.some(section => section.page.code === code))) continue;
        const page = byCode.get(code);
        if (page) append(code, page.name, `${item.code}:action:${code}`);
      }
    } else append(item.code, item.label, item.code);
    return rows.length ? [{key: item.href ? `${item.code}:${item.href}` : item.code, label: item.label, rows, expandable: Boolean(item.children?.length) || rows.length > 1}] : [];
  });
}

export function filterPermissionMenus(groups: PermissionMenuGroup[], search: string): PermissionMenuGroup[] {
  const term = search.trim().toLowerCase();
  if (!term) return groups;
  return groups.flatMap(group => {
    const rows = group.label.toLowerCase().includes(term) ? group.rows : group.rows.flatMap(row => {
      if (`${row.label} ${row.page?.name ?? ""}`.toLowerCase().includes(term)) return [row];
      const sections = row.sections.filter(section => `${section.label} ${section.page.name}`.toLowerCase().includes(term));
      return sections.length ? [{...row, sections}] : [];
    });
    return rows.length ? [{...group, rows}] : [];
  });
}

export function menuPermissionIds(groups: PermissionMenuGroup[]): string[] {
  return [...new Set(groups.flatMap(group => group.rows.flatMap(row => row.sections.length
    ? row.sections.map(section => section.page.id)
    : row.page ? [row.page.id] : [])))];
}

export function representedPermissionIds(groups: PermissionMenuGroup[]): string[] {
  return [...new Set(groups.flatMap(group => group.rows.flatMap(row => [
    ...(row.structuralPage ? [row.structuralPage.id] : []),
    ...(row.page ? [row.page.id] : []),
    ...row.sections.map(section => section.page.id),
  ])))];
}

export function additionalPermissionPages(pages: PermissionPage[], views: PermissionNavigationView[]): PermissionPage[] {
  const represented = new Set(views.flatMap(view => representedPermissionIds(permissionMenuGroups(pages, view.items, views))));
  return pages.filter(page => !represented.has(page.id));
}

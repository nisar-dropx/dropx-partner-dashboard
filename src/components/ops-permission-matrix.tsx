"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { additionalPermissionPages, filterPermissionMenus, menuPermissionIds, permissionMenuGroups, type PermissionNavigationView, type PermissionPage } from "@/lib/ops-pulse/permission-navigation";

type Action = "view" | "add" | "edit";
type Permission = { page_id: string; can_view: boolean; can_add: boolean; can_edit: boolean };
const actions: Action[] = ["view", "add", "edit"];

function SharedAccess({labels}:{labels:string[]}) {
  return labels.length ? <details className="ops-permission-shared"><summary>Shared access</summary><small>Also controls: {labels.join(", ")}. These menus use the same saved permission.</small></details> : null;
}

function AccessCheckbox({label, checked, mixed, disabled, onChange}: {label: string; checked: boolean; mixed: boolean; disabled?: boolean; onChange: (checked: boolean) => void}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="ops-permission-check"><input ref={ref} type="checkbox" aria-label={label} aria-checked={mixed ? "mixed" : checked} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /></label>;
}

export function OpsPermissionMatrix({pages, initialPermissions = [], navigationViews, initialNavigationView}: {
  pages: PermissionPage[];
  initialPermissions?: Permission[];
  navigationViews: PermissionNavigationView[];
  initialNavigationView?: string;
}) {
  const [viewKey, setViewKey] = useState(initialNavigationView ?? navigationViews[0]?.key);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAdditional, setShowAdditional] = useState(false);
  const [permissions, setPermissions] = useState<Record<string, Record<Action, boolean>>>(() => {
    const existing = new Map(initialPermissions.map(permission => [permission.page_id, permission]));
    return Object.fromEntries(pages.map(page => {
      const permission = existing.get(page.id);
      return [page.id, {view: permission?.can_view ?? false, add: permission?.can_add ?? false, edit: permission?.can_edit ?? false}];
    }));
  });
  const view = navigationViews.find(entry => entry.key === viewKey) ?? navigationViews[0];
  const groups = useMemo(() => permissionMenuGroups(pages, view?.items ?? [], navigationViews), [pages, view, navigationViews]);
  const visible = filterPermissionMenus(groups, search);
  const additional = useMemo(() => additionalPermissionPages(pages, navigationViews), [pages, navigationViews]);
  const visibleAdditional = additional.filter(page => !search.trim() || page.name.toLowerCase().includes(search.trim().toLowerCase()));
  const visibleIds = menuPermissionIds(visible);

  function update(ids: string[], action: Action | "all", checked: boolean) {
    setPermissions(previous => {
      const next = {...previous};
      for (const id of new Set(ids)) {
        const row = next[id];
        if (!row) continue;
        next[id] = action === "all" ? {view: checked, add: checked, edit: checked} : {
          ...row, [action]: action === "view" && !checked && row.edit ? true : checked,
          ...(action === "edit" && checked ? {view: true} : {})
        };
      }
      return next;
    });
  }

  function checkbox(ids: string[], action: Action | "all", label: string) {
    const values = ids.flatMap(id => (action === "all" ? actions : [action]).map(key => permissions[id]?.[key] ?? false));
    const checked = values.length > 0 && values.every(Boolean);
    const mixed = !checked && values.some(Boolean);
    return <AccessCheckbox label={`${label}: ${action === "all" ? "All actions" : action[0].toUpperCase() + action.slice(1)}`} checked={checked} mixed={mixed} disabled={!ids.length || action === "view" && ids.length === 1 && permissions[ids[0]]?.edit} onChange={value => update(ids, action, value)} />;
  }
  function cells(ids: string[], label: string) {
    return <>{(["all", ...actions] as const).map(action => <td key={action}>{checkbox(ids, action, label)}</td>)}</>;
  }
  function toggle(key: string) {
    setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  return <div className="ops-permission-editor">
    <div className="ops-permission-tools">
      <label>Workspace<select aria-label="Workspace" value={view?.key} onChange={event => {setViewKey(event.target.value); setExpanded(new Set());}}>{navigationViews.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select></label>
      <label className="ops-permission-search">Find a menu<input type="search" placeholder="Menu or submenu" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div>
    <p className="ops-permission-help">Expand + for submenu access. Menu switches apply to displayed submenus; shared access updates linked menus. Edit requires View.</p>
    <div className="table-wrap ops-permission-table-wrap"><table className="permission-table ops-permission-table">
      <thead><tr><th>Main menu <small>{visible.length}</small></th>{(["all", ...actions] as const).map(action => <th key={action}><div className="ops-permission-column-head"><span>{action === "all" ? "All" : action[0].toUpperCase() + action.slice(1)}</span>{checkbox(visibleIds, action, "Displayed menus")}</div></th>)}</tr></thead>
      <tbody>{visible.map(group => {
        const open = expanded.has(group.key) || Boolean(search.trim());
        const ids = menuPermissionIds([group]);
        return <Fragment key={group.key}>
          <tr className="ops-permission-menu-row"><td>{group.expandable ? <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${group.label}`} onClick={() => toggle(group.key)}><span aria-hidden="true">{open ? "−" : "+"}</span><strong>{group.label}</strong><small>{group.rows.length}</small></button> : <><strong className="ops-permission-single">{group.label}</strong><SharedAccess labels={group.rows[0]?.sharedWith ?? []}/></>}</td>{cells(ids, group.label)}</tr>
          {group.expandable && open ? group.rows.map(row => <tr className="ops-permission-submenu-row" key={row.key}><td><span>{row.label}</span><SharedAccess labels={row.sharedWith}/></td>{cells([row.page.id], `${group.label} / ${row.label}`)}</tr>) : null}
        </Fragment>;
      })}{!visible.length && <tr><td colSpan={5}>No matching menu in this workspace.</td></tr>}</tbody>
    </table></div>
    {additional.length > 0 && <div className="ops-permission-additional"><button type="button" className="button secondary compact" aria-expanded={showAdditional} onClick={() => setShowAdditional(value => !value)}>{showAdditional ? "−" : "+"} Additional permissions ({additional.length})</button>{showAdditional && <><p className="ops-permission-help">Existing permissions without a sidebar menu. Their saved values are retained.</p><div className="table-wrap ops-permission-table-wrap"><table className="permission-table ops-permission-table"><thead><tr><th>Permission</th><th>All</th><th>View</th><th>Add</th><th>Edit</th></tr></thead><tbody>{visibleAdditional.map(page => <tr key={page.id}><td>{page.name}</td>{cells([page.id], page.name)}</tr>)}</tbody></table></div></>}</div>}
    <p className="ops-permission-footnote">Workspace selection only changes this view. Other workspace permissions stay unchanged until you edit them. Save menu access to apply your changes.</p>
    <input name="permissions_json" type="hidden" value={JSON.stringify(pages.map(page => ({page_id: page.id, can_view: permissions[page.id]?.view ?? false, can_add: permissions[page.id]?.add ?? false, can_edit: permissions[page.id]?.edit ?? false})))} />
  </div>;
}

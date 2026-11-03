"use client";

import { Fragment, useMemo, useState } from "react";
import {
  additionalPermissionPages,
  filterPermissionMenus,
  menuPermissionIds,
  permissionMenuGroups,
  type PermissionMenuRow,
  type PermissionNavigationView,
  type PermissionPage,
} from "@/lib/ops-pulse/permission-navigation";

type Action = "view" | "add" | "edit";
type Permission = { page_id: string; can_view: boolean; can_add: boolean; can_edit: boolean };
const actions: Array<{ key: Action; label: string }> = [
  { key: "view", label: "View" },
  { key: "add", label: "Add" },
  { key: "edit", label: "Edit" },
];

export function OpsPermissionMatrix({ pages, initialPermissions = [], navigationViews, initialNavigationView }: {
  pages: PermissionPage[];
  initialPermissions?: Permission[];
  navigationViews: PermissionNavigationView[];
  initialNavigationView?: string;
}) {
  const [viewKey, setViewKey] = useState(initialNavigationView ?? navigationViews[0]?.key);
  const [search, setSearch] = useState("");
  const [expandedMenus, setExpandedMenus] = useState<Set<string>>(new Set());
  const [expandedPages, setExpandedPages] = useState<Set<string>>(new Set());
  const [showAdditional, setShowAdditional] = useState(false);
  const [permissions, setPermissions] = useState<Record<string, Record<Action, boolean>>>(() => {
    const existing = new Map(initialPermissions.map((permission) => [permission.page_id, permission]));
    return Object.fromEntries(pages.map((page) => {
      const permission = existing.get(page.id);
      return [page.id, {
        view: Boolean(permission?.can_view || permission?.can_edit),
        add: permission?.can_add ?? false,
        edit: permission?.can_edit ?? false,
      }];
    }));
  });
  const view = navigationViews.find((entry) => entry.key === viewKey) ?? navigationViews[0];
  const groups = useMemo(
    () => permissionMenuGroups(pages, view?.items ?? [], navigationViews),
    [pages, view, navigationViews],
  );
  const visible = filterPermissionMenus(groups, search);
  const additional = useMemo(() => additionalPermissionPages(pages, navigationViews), [pages, navigationViews]);
  const term = search.trim().toLowerCase();
  const visibleAdditional = additional.filter((page) => !term || `${page.name} ${page.code}`.toLowerCase().includes(term));
  const visibleIds = [...menuPermissionIds(visible), ...visibleAdditional.map((page) => page.id)];

  function updatePages(pageIds: string[], action: Action, checked: boolean) {
    setPermissions((previous) => {
      const next = { ...previous };
      for (const pageId of new Set(pageIds)) {
        const row = next[pageId];
        if (!row) continue;
        next[pageId] = {
          ...row,
          [action]: action === "view" && !checked && row.edit ? true : checked,
          ...(action === "edit" && checked ? { view: true } : {}),
        };
      }
      return next;
    });
  }

  function setAllForPages(pageIds: string[], checked: boolean) {
    setPermissions((previous) => {
      const next = { ...previous };
      for (const pageId of new Set(pageIds)) if (next[pageId]) {
        next[pageId] = { view: checked, add: checked, edit: checked };
      }
      return next;
    });
  }

  function allChecked(pageIds: string[], action: Action) {
    return pageIds.length > 0 && pageIds.every((pageId) => permissions[pageId]?.[action]);
  }

  function allFullyChecked(pageIds: string[]) {
    return pageIds.length > 0 && pageIds.every((pageId) => actions.every((action) => permissions[pageId]?.[action.key]));
  }

  function someChecked(pageIds: string[], action?: Action) {
    return pageIds.some((pageId) => action
      ? permissions[pageId]?.[action]
      : actions.some((entry) => permissions[pageId]?.[entry.key]));
  }

  function toggle(setter: typeof setExpandedMenus, key: string) {
    setter((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function cells(pageIds: string[], path: string) {
    const uniqueIds = [...new Set(pageIds)];
    const all = allFullyChecked(uniqueIds);
    return (
      <>
        <td><input aria-label={`${path}: All`} checked={all} className={`matrix-checkbox${!all && someChecked(uniqueIds) ? " partial" : ""}`} onChange={(event) => setAllForPages(uniqueIds, event.target.checked)} type="checkbox" /></td>
        {actions.map((action) => {
          const checked = allChecked(uniqueIds, action.key);
          return <td key={action.key}><input
            aria-label={`${path}: ${action.label}`}
            checked={checked}
            className={`matrix-checkbox${!checked && someChecked(uniqueIds, action.key) ? " partial" : ""}`}
            onChange={(event) => updatePages(uniqueIds, action.key, event.target.checked)}
            type="checkbox"
          /></td>;
        })}
      </>
    );
  }

  function leafRow(row: PermissionMenuRow, groupLabel: string) {
    if (!row.page) return null;
    return (
      <tr className="permission-child-row" key={row.key}>
        <td><span>{row.label}</span>{row.sharedWith.length ? <small className="ops-permission-linked-inline">Also controls {row.sharedWith.join(", ")}</small> : null}</td>
        {cells([row.page.id], `${groupLabel} / ${row.label}`)}
      </tr>
    );
  }

  return (
    <div className="ops-permission-editor">
      <div className="ops-permission-tools">
        <label>Workspace<select aria-label="Workspace" value={view?.key} onChange={(event) => {
          setViewKey(event.target.value);
          setExpandedMenus(new Set());
          setExpandedPages(new Set());
          setShowAdditional(false);
        }}>{navigationViews.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select></label>
        <label className="ops-permission-search">Find access<input type="search" placeholder="Menu, submenu or section" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      <p className="ops-permission-help">Expand a menu and page to grant each in-page section independently. Parent checkboxes are optional bulk controls for the visible rows below them.</p>

      <div className="table-wrap ops-permission-table-wrap">
        <table className="permission-table ops-permission-table">
          <thead><tr>
            <th>Menu / page / section</th>
            <th><span className="matrix-head-check">All</span></th>
            {actions.map((action) => <th key={action.key}><span className="matrix-head-check">{action.label}</span></th>)}
          </tr></thead>
          <tbody>
            {visible.map((group) => {
              const groupOpen = expandedMenus.has(group.key) || Boolean(term);
              const groupIds = menuPermissionIds([group]);
              return <Fragment key={group.key}>
                <tr className="permission-group-row">
                  <td><button className="permission-expand" onClick={() => toggle(setExpandedMenus, group.key)} type="button" aria-expanded={groupOpen} aria-label={`${groupOpen ? "Collapse" : "Expand"} ${group.label}`}>
                    <span aria-hidden="true">{groupOpen ? "−" : "+"}</span><strong>{group.label}</strong><small>{groupIds.length}</small>
                  </button></td>
                  {cells(groupIds, group.label)}
                </tr>
                {groupOpen ? group.rows.map((row) => {
                  if (!row.sections.length) return leafRow(row, group.label);
                  const pageOpen = expandedPages.has(row.key) || Boolean(term);
                  const pageIds = row.sections.map((section) => section.page.id);
                  return <Fragment key={row.key}>
                    <tr className="permission-child-row ops-permission-page-row">
                      <td><button className="permission-expand" onClick={() => toggle(setExpandedPages, row.key)} type="button" aria-expanded={pageOpen} aria-label={`${pageOpen ? "Collapse" : "Expand"} ${group.label} / ${row.label}`}>
                        <span aria-hidden="true">{pageOpen ? "−" : "+"}</span><strong>{row.label}</strong><small>{row.sections.length}</small>
                      </button></td>
                      {cells(pageIds, `${group.label} / ${row.label}`)}
                    </tr>
                    {pageOpen ? row.sections.map((section) => <tr className="permission-child-row ops-permission-section-row" key={section.key}>
                      <td><span>{section.label}</span>{section.sharedWith.length ? <small className="ops-permission-linked-inline">Also controls {section.sharedWith.join(", ")}</small> : null}</td>
                      {cells([section.page.id], `${group.label} / ${row.label} / ${section.label}`)}
                    </tr>) : null}
                  </Fragment>;
                }) : null}
              </Fragment>;
            })}
            {visibleAdditional.length ? <Fragment>
              <tr className="permission-group-row ops-permission-internal-row"><td><button className="permission-expand" onClick={() => setShowAdditional((open) => !open)} type="button" aria-expanded={showAdditional || Boolean(term)} aria-label={`${showAdditional || term ? "Collapse" : "Expand"} Internal actions`}>
                <span aria-hidden="true">{showAdditional || term ? "−" : "+"}</span><strong>Internal actions</strong><small>{visibleAdditional.length}</small>
              </button></td>{cells(visibleAdditional.map((page) => page.id), "Internal actions")}</tr>
              {showAdditional || term ? visibleAdditional.map((page) => <tr className="permission-child-row" key={page.id}><td><span>{page.name}</span></td>{cells([page.id], `Internal actions / ${page.name}`)}</tr>) : null}
            </Fragment> : null}
            {!visible.length && !visibleAdditional.length ? <tr><td className="empty-cell" colSpan={5}>No matching menu, page or section in this workspace.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="ops-permission-footnote">{term ? `${visibleIds.length} matching permissions` : `${visibleIds.length} permissions in this workspace`} · Saving keeps other workspace access unchanged.</p>
      <input name="permissions_json" type="hidden" value={JSON.stringify(pages.map((page) => ({
        page_id: page.id,
        can_view: permissions[page.id]?.view ?? false,
        can_add: permissions[page.id]?.add ?? false,
        can_edit: permissions[page.id]?.edit ?? false,
      })))} />
    </div>
  );
}

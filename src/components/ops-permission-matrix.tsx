"use client";

import { useMemo, useState } from "react";
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
const actions: Array<{ key: Action; label: string; help: string }> = [
  { key: "view", label: "View", help: "Open and read this section" },
  { key: "add", label: "Add", help: "Create or submit new records" },
  { key: "edit", label: "Edit", help: "Update, approve or take action" },
];

function SharedAccess({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  return <p className="ops-permission-linked">Linked route: this saved permission also controls {labels.join(", ")}.</p>;
}

function AccessCheckbox({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`ops-permission-action${checked ? " selected" : ""}${disabled ? " disabled" : ""}`}>
      <span><strong>{label}</strong><small>{help}</small></span>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function AccessSummary({ permission }: { permission: Record<Action, boolean> }) {
  const enabled = actions.filter((action) => permission[action.key]).map((action) => action.label);
  return <span className={`ops-permission-status${enabled.length ? " configured" : ""}`}>{enabled.length ? enabled.join(" · ") : "No access"}</span>;
}

export function OpsPermissionMatrix({ pages, initialPermissions = [], navigationViews, initialNavigationView }: {
  pages: PermissionPage[];
  initialPermissions?: Permission[];
  navigationViews: PermissionNavigationView[];
  initialNavigationView?: string;
}) {
  const [viewKey, setViewKey] = useState(initialNavigationView ?? navigationViews[0]?.key);
  const [search, setSearch] = useState("");
  const [expandedMenus, setExpandedMenus] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showAdditional, setShowAdditional] = useState(false);
  const [permissions, setPermissions] = useState<Record<string, Record<Action, boolean>>>(() => {
    const existing = new Map(initialPermissions.map((permission) => [permission.page_id, permission]));
    return Object.fromEntries(pages.map((page) => {
      const permission = existing.get(page.id);
      return [page.id, {
        view: permission?.can_view ?? false,
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
  const visibleAdditional = additional.filter((page) => !term || page.name.toLowerCase().includes(term));

  function update(id: string, action: Action, checked: boolean) {
    setPermissions((previous) => {
      const row = previous[id];
      if (!row) return previous;
      return {
        ...previous,
        [id]: {
          ...row,
          [action]: action === "view" && !checked && row.edit ? true : checked,
          ...(action === "edit" && checked ? { view: true } : {}),
        },
      };
    });
  }

  function toggle(setter: typeof setExpandedMenus, key: string) {
    setter((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function selectedCount(ids: string[]) {
    return new Set(ids).size
      ? [...new Set(ids)].filter((id) => actions.some((action) => permissions[id]?.[action.key])).length
      : 0;
  }

  function section(row: PermissionMenuRow, menuLabel: string) {
    const sectionKey = `${menuLabel}:${row.key}`;
    const open = expandedSections.has(sectionKey) || Boolean(term);
    const permission = permissions[row.page.id] ?? { view: false, add: false, edit: false };
    return (
      <div className="ops-permission-section" key={sectionKey}>
        <button
          type="button"
          className="ops-permission-section-toggle"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${menuLabel} / ${row.label}`}
          onClick={() => toggle(setExpandedSections, sectionKey)}
        >
          <span className="ops-permission-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
          <span className="ops-permission-section-name"><strong>{row.label}</strong><small>Submenu / section</small></span>
          <AccessSummary permission={permission} />
        </button>
        {open ? (
          <div className="ops-permission-section-body">
            <div className="ops-permission-actions" aria-label={`${menuLabel} / ${row.label} access`}>
              {actions.map((action) => (
                <AccessCheckbox
                  key={action.key}
                  label={`${menuLabel} / ${row.label}: ${action.label}`}
                  help={action.help}
                  checked={permission[action.key]}
                  disabled={action.key === "view" && permission.edit}
                  onChange={(checked) => update(row.page.id, action.key, checked)}
                />
              ))}
            </div>
            <SharedAccess labels={row.sharedWith} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="ops-permission-editor">
      <div className="ops-permission-tools">
        <label>Workspace<select aria-label="Workspace" value={view?.key} onChange={(event) => {
          setViewKey(event.target.value);
          setExpandedMenus(new Set());
          setExpandedSections(new Set());
        }}>{navigationViews.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select></label>
        <label className="ops-permission-search">Find access<input type="search" placeholder="Menu, submenu or section" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      <p className="ops-permission-help">Open a menu, then open only the submenu or section you want to configure. Nothing is granted from the menu heading.</p>

      <div className="ops-permission-tree">
        {visible.map((group) => {
          const open = expandedMenus.has(group.key) || Boolean(term);
          const ids = menuPermissionIds([group]);
          const configured = selectedCount(ids);
          return (
            <section className="ops-permission-menu" key={group.key}>
              <button
                type="button"
                className="ops-permission-menu-toggle"
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${group.label}`}
                onClick={() => toggle(setExpandedMenus, group.key)}
              >
                <span className="ops-permission-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
                <span className="ops-permission-menu-name"><strong>{group.label}</strong><small>{group.rows.length} submenu{group.rows.length === 1 ? "" : "s"} / sections</small></span>
                <span className={`ops-permission-menu-summary${configured ? " configured" : ""}`}>{configured ? `${configured} of ${new Set(ids).size} configured` : "No access"}</span>
              </button>
              {open ? <div className="ops-permission-menu-body">{group.rows.map((row) => section(row, group.label))}</div> : null}
            </section>
          );
        })}
        {!visible.length ? <div className="ops-permission-empty">No matching menu, submenu or section in this workspace.</div> : null}
      </div>

      {additional.length ? (
        <section className="ops-permission-advanced">
          <button type="button" className="ops-permission-advanced-toggle" aria-expanded={showAdditional} onClick={() => setShowAdditional((value) => !value)}>
            <span className="ops-permission-chevron" aria-hidden="true">{showAdditional ? "−" : "+"}</span>
            <span><strong>Internal actions</strong><small>{additional.length} permissions not shown in the sidebar</small></span>
          </button>
          {showAdditional ? <div className="ops-permission-menu-body">{visibleAdditional.map((page) => section({ key: `additional:${page.id}`, label: page.name, page, sharedWith: [] }, "Internal actions"))}</div> : null}
        </section>
      ) : null}

      <p className="ops-permission-footnote">Saving applies only the individual permissions selected above. Other workspace access is retained.</p>
      <input name="permissions_json" type="hidden" value={JSON.stringify(pages.map((page) => ({
        page_id: page.id,
        can_view: permissions[page.id]?.view ?? false,
        can_add: permissions[page.id]?.add ?? false,
        can_edit: permissions[page.id]?.edit ?? false,
      })))} />
    </div>
  );
}

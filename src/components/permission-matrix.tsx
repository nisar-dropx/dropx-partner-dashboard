"use client";

import { Fragment, useMemo, useState } from "react";

type PermissionPage = {
  id: string;
  code: string;
  name: string;
};

type PermissionAction = "view" | "add" | "edit";

type PermissionGroup = {
  key: string;
  label: string;
  codes: string[];
  hiddenCodes?: string[];
  matches?: (page: PermissionPage) => boolean;
};

const actions: Array<{ key: PermissionAction; label: string }> = [
  { key: "view", label: "View" },
  { key: "add", label: "Add" },
  { key: "edit", label: "Edit" }
];

const workforceCategoryCodes = new Set(["employees", "delivery_associates", "contractors", "vendors", "workers"]);

const groupDefinitions: PermissionGroup[] = [
  { key: "leads", label: "Leads", codes: ["leads_dashboard", "leads_all", "leads_followups", "leads_interviews", "leads_reports", "leads_ads", "leads_sop"], hiddenCodes: ["leads"] },
  { key: "fleet", label: "Fleet", codes: ["fleet_action_center", "fleet_vehicle_view", "fleet_date_view", "fleet_station_view", "fleet_tracking", "fleet_fuel_log", "fleet_live_gps", "fleet_maintenance", "fleet_reports"], hiddenCodes: ["fleet"] },
  { key: "operations", label: "Operations", codes: ["daily_submission", "cod_executive_reconciliation", "cod_submission", "cod_validation", "cod_reports", "cod_portal_checks"], hiddenCodes: ["cod"] },
  { key: "service_network", label: "Service Network", codes: ["service_network", "service_network_master"] },
  { key: "cps", label: "CPS", codes: ["cps_overview", "cps_daily", "cps_monthly", "cps_cost_breakup", "cps_stations", "cps_shipments", "cps_associates", "cps_reports", "cps_inputs", "cps_unmapped"], hiddenCodes: ["cps"] },
  { key: "payments", label: "Payments", codes: ["expense_requests", "payment_requests", "payment_approvals", "payment_process", "payment_reports"], hiddenCodes: ["payments"] },
  { key: "reports", label: "Reports", codes: ["attendance_reports", "raw_punch_reports", "verification_api_reports", "event_log_reports"], hiddenCodes: ["reports"] },
  {
    key: "onboard",
    label: "People",
    codes: ["people_all", "people_review", "executive_id_onboarding"],
    matches: (page) => workforceCategoryCodes.has(page.code) || page.code.startsWith("workforce_category_")
  },
  { key: "master_data", label: "Master Data", codes: ["master_locations", "master_providers", "master_models", "payment_methods", "master_payment_banks", "master_payment_heads", "master_contacts", "workforce_categories", "workforce_whatsapp", "designations", "biometric_devices", "cod_master", "master_documents", "master_imports"] },
  { key: "settings", label: "Settings", codes: ["app_settings", "ai_connector", "amazon_connector", "developer_mode"] }
];

// OpsPulse is the application surface, not a configurable menu group. Its
// runtime access is derived from the feature permissions assigned to the role.
const globallyHiddenCodes = new Set(["ops_pulse"]);

function emptyPermissionState(pages: PermissionPage[]) {
  return Object.fromEntries(pages.map((page) => [page.id, { view: false, add: false, edit: false }])) as Record<string, Record<PermissionAction, boolean>>;
}

export function PermissionMatrix({
  initialPermissions = [],
  pages
}: {
  initialPermissions?: Array<{ page_id: string; can_view: boolean; can_add: boolean; can_edit: boolean }>;
  pages: PermissionPage[];
}) {
  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [permissions, setPermissions] = useState(() => {
    const state = emptyPermissionState(pages);
    for (const permission of initialPermissions) {
      state[permission.page_id] = {
        view: permission.can_view || permission.can_edit,
        add: permission.can_add,
        edit: permission.can_edit
      };
    }
    return state;
  });

  const groups = useMemo(() => groupDefinitions.map((definition) => ({
    ...definition,
    pages: pages.filter((page) => definition.codes.includes(page.code) || definition.matches?.(page)),
    hiddenPages: (definition.hiddenCodes ?? []).flatMap((code) => pages.filter((page) => page.code === code))
  })).filter((group) => group.pages.length), [pages]);
  const groupedPageIds = useMemo(() => new Set(groups.flatMap((group) => [...group.pages, ...group.hiddenPages].map((page) => page.id))), [groups]);
  const standalonePages = useMemo(() => pages.filter((page) => !groupedPageIds.has(page.id) && !globallyHiddenCodes.has(page.code)), [pages, groupedPageIds]);
  const term = search.trim().toLowerCase();
  const visibleGroups = groups.map((group) => {
    const groupMatches = group.label.toLowerCase().includes(term);
    return { ...group, visiblePages: !term || groupMatches ? group.pages : group.pages.filter((page) => page.name.toLowerCase().includes(term)) };
  }).filter((group) => group.visiblePages.length);
  const visibleStandalonePages = standalonePages.filter((page) => !term || page.name.toLowerCase().includes(term));
  const filteredPages = [...visibleGroups.flatMap((group) => group.visiblePages), ...visibleStandalonePages];

  function updatePages(pageIds: string[], action: PermissionAction, checked: boolean) {
    setPermissions((current) => {
      const next = { ...current };
      pageIds.forEach((pageId) => {
        const row = next[pageId];
        next[pageId] = {
          ...row,
          [action]: action === "view" && !checked && row.edit ? true : checked,
          ...(action === "edit" && checked ? { view: true } : {})
        };
      });
      return next;
    });
  }

  function setAllForPages(pageIds: string[], checked: boolean) {
    setPermissions((current) => {
      const next = { ...current };
      pageIds.forEach((pageId) => { next[pageId] = { view: checked, add: checked, edit: checked }; });
      return next;
    });
  }

  function allPagesChecked(pageIds: string[], action: PermissionAction) {
    return pageIds.length > 0 && pageIds.every((pageId) => permissions[pageId]?.[action]);
  }

  function allPagesFullyChecked(pageIds: string[]) {
    return pageIds.length > 0 && pageIds.every((pageId) => actions.every((action) => permissions[pageId]?.[action.key]));
  }

  function somePagesChecked(pageIds: string[], action: PermissionAction) {
    return pageIds.some((pageId) => permissions[pageId]?.[action]);
  }

  function somePermissionChecked(pageIds: string[]) {
    return pageIds.some((pageId) => actions.some((action) => permissions[pageId]?.[action.key]));
  }

  function checkboxClass(partial: boolean) {
    return `matrix-checkbox${partial ? " partial" : ""}`;
  }

  function toggleGroup(key: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function permissionCells(pageIds: string[], keyPrefix: string) {
    const fullyChecked = allPagesFullyChecked(pageIds);
    const partiallyChecked = !fullyChecked && somePermissionChecked(pageIds);
    return (
      <>
        <td><input aria-checked={partiallyChecked ? "mixed" : fullyChecked} checked={fullyChecked} className={checkboxClass(partiallyChecked)} onChange={(event) => setAllForPages(pageIds, event.target.checked)} type="checkbox" /></td>
        {actions.map((action) => (
          <td key={`${keyPrefix}-${action.key}`}>
            <input
              checked={allPagesChecked(pageIds, action.key)}
              className={checkboxClass(!allPagesChecked(pageIds, action.key) && somePagesChecked(pageIds, action.key))}
              disabled={action.key === "view" && pageIds.some((pageId) => Boolean(permissions[pageId]?.edit))}
              onChange={(event) => updatePages(pageIds, action.key, event.target.checked)}
              type="checkbox"
            />
          </td>
        ))}
      </>
    );
  }

  return (
    <>
      <div className="permission-toolbar">
        <input className="field" onChange={(event) => setSearch(event.target.value)} placeholder="Search page" value={search} />
        <span className="subtle">{term ? `${filteredPages.length} matches` : `${filteredPages.length} permissions`}</span>
      </div>
      <div className="table-wrap">
        <table className="permission-table">
          <thead>
            <tr>
              <th>Page name</th>
              <th><label className="matrix-head-check"><span>All</span><input checked={allPagesFullyChecked(filteredPages.map((page) => page.id))} className={checkboxClass(!allPagesFullyChecked(filteredPages.map((page) => page.id)) && somePermissionChecked(filteredPages.map((page) => page.id)))} onChange={(event) => setAllForPages(filteredPages.map((page) => page.id), event.target.checked)} type="checkbox" /></label></th>
              {actions.map((action) => (
                <th key={action.key}><label className="matrix-head-check"><span>{action.label}</span><input checked={allPagesChecked(filteredPages.map((page) => page.id), action.key)} className={checkboxClass(!allPagesChecked(filteredPages.map((page) => page.id), action.key) && somePagesChecked(filteredPages.map((page) => page.id), action.key))} onChange={(event) => updatePages(filteredPages.map((page) => page.id), action.key, event.target.checked)} type="checkbox" /></label></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleGroups.map((group) => {
              const isExpanded = expandedGroups.has(group.key) || Boolean(term);
              const pageIds = [...group.pages, ...group.hiddenPages].map((page) => page.id);
              return (
                <Fragment key={group.key}>
                  <tr className="permission-group-row">
                    <td>
                      <button className="permission-expand" onClick={() => toggleGroup(group.key)} type="button" aria-expanded={isExpanded}>
                        <span aria-hidden="true">{isExpanded ? "−" : "+"}</span><strong>{group.label}</strong><small>{group.pages.length}</small>
                      </button>
                    </td>
                    {permissionCells(pageIds, group.key)}
                  </tr>
                  {isExpanded ? group.visiblePages.map((page) => (
                    <tr className="permission-child-row" key={page.id}>
                      <td><span>{page.name}</span></td>
                      {permissionCells([page.id], page.id)}
                    </tr>
                  )) : null}
                </Fragment>
              );
            })}
            {visibleStandalonePages.map((page) => (
              <tr key={page.id}>
                <td><strong>{page.name}</strong></td>
                {permissionCells([page.id], page.id)}
              </tr>
            ))}
            {!filteredPages.length ? <tr><td className="empty-cell" colSpan={5}>No pages found.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <input name="permissions_json" type="hidden" value={JSON.stringify(pages.map((page) => ({
        page_id: page.id,
        can_view: permissions[page.id]?.view ?? false,
        can_add: permissions[page.id]?.add ?? false,
        can_edit: permissions[page.id]?.edit ?? false
      })))} />
    </>
  );
}

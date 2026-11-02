"use client";
import { ReportTable } from "@/components/report-table";


import { useEffect, useMemo, useRef, useState } from "react";
import { bulkMetaLeadAdAction, changeMetaLeadAdStatus, deleteMetaLeadAd, removeLocalLeadAd } from "@/app/leads/actions";
import { SubmitButton } from "@/components/submit-button";
import { formatDashboardDate } from "@/lib/date-format";
import type { LeadAdRow } from "@/lib/leads-data";

const pageSize = 20;
const statusOrder = new Map([
  ["active", 0],
  ["paused", 1],
  ["unknown", 2],
  ["stopped", 3],
  ["archived", 4]
]);

function EmptyState({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

function clean(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function formatDate(value: string | null) {
  return formatDashboardDate(value);
}

function formatMoney(value: number | null | undefined) {
  if (value == null) return "-";
  return `Rs ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function budgetText(value: number | null | undefined) {
  if (value == null || Number(value) <= 0) return "-";
  return `${formatMoney(value)}/Day`;
}

function uniqueOptions(values: Array<string | null | undefined>) {
  return [...new Set(values.map(clean).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function sortAds(rows: LeadAdRow[]) {
  return [...rows].sort((left, right) => {
    const leftStatus = statusOrder.get(clean(left.status).toLowerCase()) ?? 9;
    const rightStatus = statusOrder.get(clean(right.status).toLowerCase()) ?? 9;
    if (leftStatus !== rightStatus) return leftStatus - rightStatus;
    const leftTime = left.created_on ? new Date(left.created_on).getTime() : 0;
    const rightTime = right.created_on ? new Date(right.created_on).getTime() : 0;
    return rightTime - leftTime;
  });
}

function nextPrimaryAction(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "active") return { label: "Pause", status: "PAUSED" };
  return { label: "Activate", status: "ACTIVE" };
}

function MultiCheckFilter({
  label,
  options,
  selected,
  onChange
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const filteredOptions = useMemo(() => {
    const text = query.trim().toLowerCase();
    return options.filter((option) => !text || option.toLowerCase().includes(text));
  }, [options, query]);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  function toggleValue(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className="bulk-multi-filter lead-multi-filter" ref={ref}>
      <button
        className={`bulk-multi-filter-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{selected.length ? `${selected.length} selected` : label}</span>
        <strong>v</strong>
      </button>
      {open ? (
        <div className="bulk-multi-filter-menu">
          <div className="bulk-multi-filter-search">
            <input
              className="field"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}`}
              value={query}
            />
          </div>
          <div className="bulk-multi-filter-options">
            <label className="bulk-multi-filter-option all">
              <input checked={!selected.length} onChange={() => onChange([])} type="checkbox" />
              <span>{label}</span>
            </label>
            {filteredOptions.map((option) => (
              <label className="bulk-multi-filter-option" key={option}>
                <input checked={selected.includes(option)} onChange={() => toggleValue(option)} type="checkbox" />
                <span>{option}</span>
              </label>
            ))}
            {!filteredOptions.length ? <div className="dropdown-empty">No items found.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LeadAdActionMenu({ ad, canEdit }: { ad: LeadAdRow; canEdit: boolean }) {
  const primary = nextPrimaryAction(ad.status);
  const isArchived = clean(ad.status).toLowerCase() === "archived";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  return (
    <div className={`lead-action-menu ${open ? "open" : ""}`} ref={ref}>
      <button
        aria-expanded={open}
        aria-label={`Actions for ${ad.ad_name}`}
        className="lead-action-menu-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        ...
      </button>
      {open ? (
        <div className="lead-action-dropdown">
        {canEdit && isArchived ? (
          <form action={removeLocalLeadAd}>
            <input name="adRowId" type="hidden" value={ad.id} />
            <SubmitButton
              className="plain-menu-button danger"
              confirmDescription="This removes only the local dashboard row. It will not change Meta Ads Manager."
              confirmMessage={`Remove ${ad.ad_name} from this list?`}
              confirmSubmitText="Remove"
              confirmTitle="Remove archived ad"
              pendingText="Removing"
            >
              Remove
            </SubmitButton>
          </form>
        ) : null}
        {canEdit && ad.meta_ad_id && !isArchived ? (
          <>
            <form action={changeMetaLeadAdStatus}>
              <input name="adId" type="hidden" value={ad.meta_ad_id} />
              <input name="nextStatus" type="hidden" value={primary.status} />
              <SubmitButton
                className="plain-menu-button"
                confirmDescription={`This will change ${ad.ad_name} in Meta Ads Manager.`}
                confirmMessage={`${primary.label} this ad?`}
                confirmSubmitText={primary.label}
                confirmTitle={`${primary.label} ad`}
                pendingText="Saving"
              >
                {primary.label}
              </SubmitButton>
            </form>
            <form action={changeMetaLeadAdStatus}>
              <input name="adId" type="hidden" value={ad.meta_ad_id} />
              <input name="nextStatus" type="hidden" value="ARCHIVED" />
              <SubmitButton
                className="plain-menu-button"
                confirmDescription={`This will stop ${ad.ad_name} in Meta Ads Manager.`}
                confirmMessage="Stop this ad?"
                confirmSubmitText="Stop"
                confirmTitle="Stop ad"
                pendingText="Saving"
              >
                Stop
              </SubmitButton>
            </form>
            <form action={deleteMetaLeadAd}>
              <input name="adId" type="hidden" value={ad.meta_ad_id} />
              <SubmitButton
                className="plain-menu-button danger"
                confirmDescription="This will delete the ad in Meta Ads Manager and archive the local row."
                confirmationCheckboxes={[
                  { name: "deleteAdSet", label: "Delete Ad Sets", defaultChecked: true },
                  { name: "deleteCampaign", label: "Delete Ad Campaigns", defaultChecked: true }
                ]}
                confirmMessage={`Delete ${ad.ad_name}?`}
                confirmSubmitText="Delete"
                confirmTitle="Delete ad"
                pendingText="Deleting"
              >
                Delete
              </SubmitButton>
            </form>
          </>
        ) : null}
        {ad.poster_url ? (
          <a href={ad.poster_url} target="_blank" rel="noreferrer">View Poster</a>
        ) : (
          <span className="disabled">No Poster</span>
        )}
        </div>
      ) : null}
    </div>
  );
}

export function LeadAdsPanel({ ads, canEdit }: { ads: LeadAdRow[]; canEdit: boolean }) {
  const [search, setSearch] = useState("");
  const [stationsSelected, setStationsSelected] = useState<string[]>([]);
  const [rolesSelected, setRolesSelected] = useState<string[]>([]);
  const [statusesSelected, setStatusesSelected] = useState<string[]>([]);
  const [selectedAdIds, setSelectedAdIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState("");
  const [page, setPage] = useState(1);

  const stations = useMemo(() => uniqueOptions(ads.map((ad) => ad.station_code)), [ads]);
  const roles = useMemo(() => uniqueOptions(ads.map((ad) => ad.job_code)), [ads]);
  const statuses = useMemo(() => uniqueOptions(ads.map((ad) => ad.status)), [ads]);
  const filteredAds = useMemo(() => {
    const text = search.trim().toLowerCase();
    return sortAds(ads).filter((ad) => {
      const haystack = [ad.ad_name, ad.station_code, ad.job_code, ad.status].map(clean).join(" ").toLowerCase();
      return (!text || haystack.includes(text)) &&
        (!stationsSelected.length || stationsSelected.includes(clean(ad.station_code))) &&
        (!rolesSelected.length || rolesSelected.includes(clean(ad.job_code))) &&
        (!statusesSelected.length || statusesSelected.includes(clean(ad.status)));
    });
  }, [ads, rolesSelected, search, stationsSelected, statusesSelected]);
  const totalPages = Math.max(1, Math.ceil(filteredAds.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleAds = filteredAds.slice((safePage - 1) * pageSize, safePage * pageSize);
  const visibleMetaIds = visibleAds.map((ad) => ad.meta_ad_id).filter(Boolean) as string[];
  const selectedVisibleCount = visibleMetaIds.filter((id) => selectedAdIds.includes(id)).length;
  const selectedCount = selectedAdIds.length;

  function updateFilter(callback: () => void) {
    callback();
    setPage(1);
    setSelectedAdIds([]);
  }

  function toggleAllVisible() {
    if (selectedVisibleCount === visibleMetaIds.length) {
      setSelectedAdIds((current) => current.filter((id) => !visibleMetaIds.includes(id)));
      return;
    }
    setSelectedAdIds((current) => Array.from(new Set([...current, ...visibleMetaIds])));
  }

  function toggleAd(id: string) {
    setSelectedAdIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function clearFilters() {
    setSearch("");
    setStationsSelected([]);
    setRolesSelected([]);
    setStatusesSelected([]);
    setSelectedAdIds([]);
    setPage(1);
  }

  return (
    <>
      <div className="lead-filter-bar">
        <input
          className="field"
          onChange={(event) => updateFilter(() => setSearch(event.target.value))}
          placeholder="Search ad, station, role"
          value={search}
        />
        <MultiCheckFilter label="All Stations" onChange={(values) => updateFilter(() => setStationsSelected(values))} options={stations} selected={stationsSelected} />
        <MultiCheckFilter label="All Roles" onChange={(values) => updateFilter(() => setRolesSelected(values))} options={roles} selected={rolesSelected} />
        <MultiCheckFilter label="Ad Status" onChange={(values) => updateFilter(() => setStatusesSelected(values))} options={statuses} selected={statusesSelected} />
        <button className="button secondary compact" onClick={clearFilters} type="button">Clear</button>
        {canEdit ? (
          <form action={bulkMetaLeadAdAction} className="lead-bulk-action-form">
            {selectedAdIds.map((id) => <input key={id} name="adIds" type="hidden" value={id} />)}
            <select className="field" disabled={!selectedCount} name="bulkAction" onChange={(event) => setBulkAction(event.target.value)} required value={bulkAction}>
              <option value="">Bulk action</option>
              <option value="ACTIVE">Activate</option>
              <option value="PAUSED">Pause</option>
              <option value="ARCHIVED">Stop</option>
              <option value="DELETE">Delete</option>
            </select>
            <SubmitButton
              className="button secondary compact"
              confirmDescription={`${selectedCount.toLocaleString("en-IN")} selected ads will be changed in Meta Ads Manager.`}
              confirmationCheckboxes={bulkAction === "DELETE" ? [
                { name: "deleteAdSet", label: "Delete Ad Sets", defaultChecked: true },
                { name: "deleteCampaign", label: "Delete Ad Campaigns", defaultChecked: true }
              ] : undefined}
              confirmMessage="Apply bulk action?"
              confirmSubmitText="Yes"
              confirmTitle="Confirm bulk action"
              disabled={!selectedCount}
              pendingText="Saving"
            >
              Apply
            </SubmitButton>
          </form>
        ) : null}
      </div>

      <div className="table-wrap">
        <ReportTable className="lead-table lead-ads-table">
          <thead>
            <tr>
              {canEdit ? (
                <th className="check-cell">
                  <input
                    aria-label="Select all ads on this page"
                    checked={Boolean(visibleMetaIds.length) && selectedVisibleCount === visibleMetaIds.length}
                    onChange={toggleAllVisible}
                    type="checkbox"
                  />
                </th>
              ) : null}
              <th>Ad Name</th>
              <th>Station</th>
              <th>Role</th>
              <th>Budget</th>
              <th>Total Spend</th>
              <th>Created</th>
              <th>Leads</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleAds.length ? visibleAds.map((ad) => (
              <tr key={ad.id}>
                {canEdit ? (
                  <td className="check-cell">
                    {ad.meta_ad_id ? (
                      <input
                        aria-label={`Select ${ad.ad_name}`}
                        checked={selectedAdIds.includes(ad.meta_ad_id)}
                        onChange={() => toggleAd(ad.meta_ad_id as string)}
                        type="checkbox"
                      />
                    ) : null}
                  </td>
                ) : null}
                <td><strong>{ad.ad_name}</strong></td>
                <td>{ad.station_code || "-"}</td>
                <td>{ad.job_code || "-"}</td>
                <td>{budgetText(ad.daily_budget)}</td>
                <td>{formatMoney(ad.total_spend ?? 0)}</td>
                <td>{formatDate(ad.created_on)}</td>
                <td>{ad.leads_count}</td>
                <td><span className={`status-pill ad-status ${clean(ad.status).toLowerCase()}`}>{ad.status}</span></td>
                <td><LeadAdActionMenu ad={ad} canEdit={canEdit} /></td>
              </tr>
            )) : (
              <tr><td colSpan={canEdit ? 10 : 9}><EmptyState>No ad data for selected filters.</EmptyState></td></tr>
            )}
          </tbody>
        </ReportTable>
      </div>

      <div className="panel-foot pagination">
        <span>{filteredAds.length.toLocaleString("en-IN")} ads</span>
        <button className="button secondary" disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">Previous</button>
        <span>Page {safePage} of {totalPages}</span>
        <button className="button secondary" disabled={safePage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} type="button">Next</button>
      </div>
    </>
  );
}

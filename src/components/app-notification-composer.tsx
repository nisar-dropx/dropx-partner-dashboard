"use client";
import { ReportTable } from "@/components/report-table";


import { ChevronDown, Link2, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { WorkforceProfileType } from "@/lib/workforce-profiles";

export type AppNotificationRecipient = {
  id: string;
  profileType: WorkforceProfileType;
  name: string;
  reference: string;
  biometricId: string;
  category: string;
  location: string;
  designation: string;
  mobile: string;
  countryCode: string;
  email: string;
  provider: string;
  model: string;
  status: string;
};

type FilterOption = { value: string; label: string };

const variables = [
  { token: "{full_name}", label: "Full name" },
  { token: "{dropx_id}", label: "DropX ID" },
  { token: "{biometric_id}", label: "Biometric ID" },
  { token: "{category}", label: "Category" },
  { token: "{location}", label: "Location" },
  { token: "{designation}", label: "Designation" }
];

const pageSize = 10;

function keyFor(recipient: AppNotificationRecipient) {
  return `${recipient.profileType}:${recipient.id}`;
}

function uniqueOptions(values: string[]): FilterOption[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }));
}

function displayMobile(mobile: string, countryCode: string) {
  const digits = mobile.replace(/\D/g, "");
  const code = countryCode.replace(/\D/g, "") || "91";
  const localNumber = digits.startsWith(code) && digits.length > 10 ? digits.slice(code.length) : digits;
  return localNumber ? `+${code} ${localNumber}` : "-";
}

function MultiCheckFilter({
  label,
  options,
  selected,
  onChange
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const shown = useMemo(() => {
    const normalized = term.trim().toLowerCase();
    return normalized ? options.filter((option) => option.label.toLowerCase().includes(normalized)) : options;
  }, [options, term]);
  const summary = selected.length ? `${selected.length} selected` : label;

  useEffect(() => {
    function close(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function toggle(value: string) {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  }

  return (
    <div className="bulk-multi-filter" ref={rootRef}>
      <button className={`bulk-multi-filter-trigger ${open ? "open" : ""}`} onClick={() => setOpen((value) => !value)} type="button">
        <span>{summary}</span><ChevronDown aria-hidden="true" size={15} />
      </button>
      {open ? (
        <div className="bulk-multi-filter-menu">
          <label className="bulk-multi-filter-search">
            <Search aria-hidden="true" size={15} />
            <input onChange={(event) => setTerm(event.target.value)} placeholder="Search" value={term} />
          </label>
          <div className="bulk-multi-filter-actions">
            <button onClick={() => onChange(options.map((option) => option.value))} type="button">Select all</button>
            <button onClick={() => onChange([])} type="button">Clear</button>
          </div>
          <div className="bulk-multi-filter-options">
            {shown.map((option) => (
              <label key={option.value}>
                <input checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
                <span>{option.label}</span>
              </label>
            ))}
            {!shown.length ? <p className="subtle">No options found.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SendButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button className="app-notification-send" disabled={pending || count === 0} type="submit">
      {pending ? "Sending..." : `Send to ${count} ${count === 1 ? "person" : "people"}`}
    </button>
  );
}

export function AppNotificationComposer({
  action,
  recipients
}: {
  action: (formData: FormData) => void | Promise<void>;
  recipients: AppNotificationRecipient[];
}) {
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [designations, setDesignations] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [sendListKeys, setSendListKeys] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [openTarget, setOpenTarget] = useState("");
  const [activeField, setActiveField] = useState<"title" | "body">("body");
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const categoryOptions = useMemo(() => uniqueOptions(recipients.map((row) => row.category)), [recipients]);
  const providerOptions = useMemo(() => uniqueOptions(recipients.map((row) => row.provider)), [recipients]);
  const modelOptions = useMemo(() => uniqueOptions(recipients.map((row) => row.model)), [recipients]);
  const locationOptions = useMemo(() => uniqueOptions(recipients.map((row) => row.location)), [recipients]);
  const designationOptions = useMemo(() => uniqueOptions(recipients.map((row) => row.designation)), [recipients]);
  const statusOptions = useMemo(() => uniqueOptions(recipients.map((row) => row.status)), [recipients]);
  const checkedSet = useMemo(() => new Set(checkedKeys), [checkedKeys]);
  const sendListSet = useMemo(() => new Set(sendListKeys), [sendListKeys]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return recipients.filter((recipient) => {
      if (categories.length && !categories.includes(recipient.category)) return false;
      if (providers.length && !providers.includes(recipient.provider)) return false;
      if (models.length && !models.includes(recipient.model)) return false;
      if (locations.length && !locations.includes(recipient.location)) return false;
      if (designations.length && !designations.includes(recipient.designation)) return false;
      if (statuses.length && !statuses.includes(recipient.status)) return false;
      if (!term) return true;
      return [recipient.name, recipient.reference, recipient.biometricId, recipient.mobile, recipient.email]
        .join(" ").toLowerCase().includes(term);
    });
  }, [categories, designations, locations, models, providers, query, recipients, statuses]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const checked = recipients.filter((recipient) => checkedSet.has(keyFor(recipient)));
  const sendList = recipients.filter((recipient) => sendListSet.has(keyFor(recipient)));

  useEffect(() => setPage(1), [query, categories, providers, models, locations, designations, statuses]);

  function toggleRecipient(recipient: AppNotificationRecipient) {
    const key = keyFor(recipient);
    setCheckedKeys((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  }

  function selectCurrent() {
    setCheckedKeys((current) => Array.from(new Set([...current, ...visible.map(keyFor)])));
  }

  function selectAllFiltered() {
    setCheckedKeys((current) => Array.from(new Set([...current, ...filtered.map(keyFor)])));
  }

  function addToList() {
    setSendListKeys((current) => Array.from(new Set([...current, ...checkedKeys])));
    setCheckedKeys([]);
  }

  function clearAll() {
    setCheckedKeys([]);
    setSendListKeys([]);
  }

  function insertVariable(token: string) {
    const target = activeField === "title" ? titleRef.current : bodyRef.current;
    if (!target) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const nextValue = `${target.value.slice(0, start)}${token}${target.value.slice(end)}`;
    const setter = Object.getOwnPropertyDescriptor(
      target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(target, nextValue);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.focus();
    requestAnimationFrame(() => target.setSelectionRange(start + token.length, start + token.length));
  }

  return (
    <form action={action}>
      <input name="selectedRecipients" type="hidden" value={JSON.stringify(sendListKeys)} />
      <section className="wide app-notification-recipient-workbench">
        <div className="app-notification-recipient-head">
          <div><h3>Recipients</h3><p>{sendList.length} in send list, {checked.length} selected</p></div>
          <div className="bulk-recipient-filters app-bulk-recipient-filters">
            <input className="field" onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, name, mobile, email" value={query} />
            <MultiCheckFilter label="All data" onChange={setCategories} options={categoryOptions} selected={categories} />
            <MultiCheckFilter label="All providers" onChange={setProviders} options={providerOptions} selected={providers} />
            <MultiCheckFilter label="All models" onChange={setModels} options={modelOptions} selected={models} />
            <MultiCheckFilter label="All locations" onChange={setLocations} options={locationOptions} selected={locations} />
            <MultiCheckFilter label="All designations" onChange={setDesignations} options={designationOptions} selected={designations} />
            <MultiCheckFilter label="All statuses" onChange={setStatuses} options={statusOptions} selected={statuses} />
          </div>
        </div>
        <div className="bulk-list-actions">
          <div className="bulk-filter-counts"><strong>{filtered.length}</strong> filtered<span>{visible.length} on page</span><span>{checked.length} selected</span></div>
          <button className="button ghost compact" disabled={!visible.length} onClick={selectCurrent} type="button">Select Current</button>
          <button className="button ghost compact" disabled={!filtered.length} onClick={selectAllFiltered} type="button">Select All Filtered</button>
          <button className="button secondary compact" disabled={!checked.length} onClick={addToList} type="button">Add to list</button>
          <button className="button ghost compact" disabled={!sendList.length && !checked.length} onClick={clearAll} type="button">Clear</button>
        </div>
        <div className="table-wrap">
          <ReportTable>
            <thead><tr><th><input aria-label="Select visible recipients" checked={visible.length > 0 && visible.every((row) => checkedSet.has(keyFor(row)))} onChange={() => visible.every((row) => checkedSet.has(keyFor(row))) ? setCheckedKeys((current) => current.filter((key) => !visible.some((row) => keyFor(row) === key))) : selectCurrent()} type="checkbox" /></th><th>Name</th><th>Mobile</th><th>Source</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>
              {visible.map((recipient) => <tr key={keyFor(recipient)}>
                <td><input checked={checkedSet.has(keyFor(recipient))} onChange={() => toggleRecipient(recipient)} type="checkbox" /></td>
                <td><strong>{recipient.name}</strong><br /><span className="subtle">{[recipient.reference, recipient.email].filter(Boolean).join(" | ") || "-"}</span></td>
                <td>{displayMobile(recipient.mobile, recipient.countryCode)}</td>
                <td><strong>{recipient.category}</strong><br /><span className="subtle">{recipient.designation || "-"}</span></td>
                <td>{recipient.location || "-"}</td><td>{recipient.status}</td>
              </tr>)}
              {!visible.length ? <tr><td className="empty-cell" colSpan={6}>No recipients found.</td></tr> : null}
            </tbody>
          </ReportTable>
        </div>
        {totalPages > 1 ? <div className="panel-foot pagination"><button className="pager-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} type="button">Prev</button><span>Page {currentPage} of {totalPages}</span><button className="pager-button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button></div> : null}
        <div className="bulk-send-list">
          <div className="bulk-send-list-head"><strong>Send list</strong><span className="subtle">{sendList.length} contact{sendList.length === 1 ? "" : "s"}</span></div>
          {sendList.length ? <div className="bulk-send-list-tags">{sendList.map((recipient) => <button key={keyFor(recipient)} onClick={() => setSendListKeys((current) => current.filter((key) => key !== keyFor(recipient)))} title="Remove from send list" type="button"><span>{recipient.name}</span><small>{recipient.reference || recipient.mobile}</small><X aria-hidden="true" size={13} /></button>)}</div> : <p className="subtle">Select recipients above and click Add to list.</p>}
        </div>
      </section>

      <label>Title<input maxLength={120} name="title" onFocus={() => setActiveField("title")} placeholder="Notification title" ref={titleRef} required /></label>
      <label>Open page<select name="openTarget" onChange={(event) => setOpenTarget(event.target.value)} value={openTarget}><option value="">No linked page</option><option value="dashboard">Dashboard</option><option value="profile">My Profile</option><option value="attendance">Attendance</option><option value="leave">Leave</option><option value="settings">Settings</option><option value="custom_url">Custom URL</option></select></label>
      {openTarget === "custom_url" ? <label className="wide app-notification-custom-url">Custom URL<span><Link2 aria-hidden="true" size={17} /><input maxLength={2048} name="customUrl" placeholder="https://example.com/page" required type="url" /></span></label> : null}
      <label className="wide">Message<textarea maxLength={1000} name="body" onFocus={() => setActiveField("body")} placeholder="Write the notification message" ref={bodyRef} required rows={4} /></label>
      <div className="wide app-notification-variables"><span>Insert into {activeField === "title" ? "title" : "message"}</span><div>{variables.map((variable) => <button key={variable.token} onClick={() => insertVariable(variable.token)} type="button">{variable.label}</button>)}</div><small>Each variable is replaced separately for every selected person.</small></div>
      <SendButton count={sendList.length} />
    </form>
  );
}

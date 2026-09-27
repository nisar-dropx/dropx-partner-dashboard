"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as XLSX from "xlsx";
import { CampaignReport, type Campaign } from "@/components/campaign-report";
import { SearchableSelect } from "@/components/searchable-select";
import { TemplateMediaPreview } from "@/components/template-media-preview";
import { acceptsForHeaderMedia } from "@/lib/whatsapp-media";
import { extractWhatsAppTemplateVariables, getWhatsAppTemplateHeaderMediaType, type WhatsAppTemplateComponent } from "@/lib/whatsapp-template";

type Template = {
  template_id: string;
  whatsapp_profile_id: string | null;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: WhatsAppTemplateComponent[];
};

type WhatsAppProfile = {
  id: string;
  profile_name: string;
  phone_number_id: string;
  default_country_code: string;
  is_default: boolean;
  is_active: boolean;
};

type Contact = {
  id: string;
  source: string;
  name: string;
  mobile: string;
  email: string;
  dropx_id?: string;
  location: string;
  provider?: string;
  model?: string;
  role: string;
  designation?: string;
  status: string;
  country_code?: string;
};

type MappingRule = {
  mode: "field" | "constant";
  value: string;
};

type CountryCodeMode = "default" | "excel" | "constant";
type FilterOption = { value: string; label: string; helper?: string };
type BulkSendRecipient = {
  id: string;
  source: string;
  name?: string;
  mobile?: string;
  email?: string;
  location?: string;
  role?: string;
  country_code?: string;
  [key: string]: unknown;
};

const maxCampaignRecipients = 10000;

type ProgressState = {
  open: boolean;
  phase: "confirm" | "sending" | "done";
  total: number;
  current: number;
  sent: number;
  failed: number;
  message: string;
  campaignCode?: string;
};

const databaseFieldOptions = [
  { value: "name", label: "Name" },
  { value: "mobile", label: "Mobile number" },
  { value: "email", label: "Email" },
  { value: "dropx_id", label: "DropX ID" },
  { value: "source", label: "Source" },
  { value: "location", label: "Location" },
  { value: "provider", label: "Provider" },
  { value: "model", label: "Model" },
  { value: "role", label: "Role / designation" },
  { value: "status", label: "Status" },
  { value: "country_code", label: "Country code" }
];

const pageSize = 10;

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function displayMobile(mobile: string, countryCode?: string) {
  const digits = mobile.replace(/\D/g, "");
  const code = String(countryCode || "91").replace(/\D/g, "") || "91";
  const localNumber = digits.startsWith(code) && digits.length > 10
    ? digits.slice(code.length)
    : digits;
  return `+${code} ${localNumber}`;
}

function replaceVariables(text: string | undefined, component: "header" | "body", mappings: Record<string, MappingRule>) {
  return (text || "").replace(/\{\{(\d+)\}\}/g, (_, position: string) => {
    const rule = mappings[`${component}.${position}`];
    if (!rule?.value) return `[${component} ${position}]`;
    return rule.mode === "constant" ? rule.value : `{${rule.value}}`;
  });
}

function buildTemplatePreview(template: Template | null, mappings: Record<string, MappingRule>) {
  if (!template) return { header: "", body: "Select a template to preview the message.", buttons: [] as string[] };
  let header = "";
  let body = "";
  const buttons: string[] = [];
  template.components.forEach((component) => {
    const type = component.type?.toUpperCase();
    if (type === "HEADER") header = replaceVariables(component.text, "header", mappings);
    if (type === "BODY") body = replaceVariables(component.text, "body", mappings);
    if (type === "BUTTONS") {
      (component.buttons ?? []).forEach((button, index) => {
        const buttonText = button.text || "Button";
        const url = (button.url || "").replace(/\{\{(\d+)\}\}/g, (_, position: string) => {
          const rule = mappings[`button.${index}.${position}`];
          if (!rule?.value) return `[button ${position}]`;
          return rule.mode === "constant" ? rule.value : `{${rule.value}}`;
        });
        buttons.push(url ? `${buttonText}: ${url}` : buttonText);
      });
    }
  });
  return { header, body: body || "This template has no body text.", buttons };
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredOptions = useMemo(() => {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) => `${option.label} ${option.helper ?? ""}`.toLowerCase().includes(normalized));
  }, [options, term]);
  const selectedLabels = options.filter((option) => selectedSet.has(option.value)).map((option) => option.label);
  const summary = selectedLabels.length
    ? selectedLabels.length <= 2 ? selectedLabels.join(", ") : `${selectedLabels.length} selected`
    : label;

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function toggle(value: string) {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  }

  function toggleAll() {
    const filteredValues = filteredOptions.map((option) => option.value);
    const allFilteredSelected = filteredValues.length > 0 && filteredValues.every((value) => selectedSet.has(value));
    if (allFilteredSelected) onChange(selected.filter((value) => !filteredValues.includes(value)));
    else onChange(Array.from(new Set([...selected, ...filteredValues])));
  }

  return (
    <div className="bulk-multi-filter" ref={containerRef}>
      <button className={`bulk-multi-filter-trigger ${open ? "open" : ""}`} onClick={() => setOpen((current) => !current)} type="button">
        <span>{summary}</span>
        <strong>v</strong>
      </button>
      {open ? (
        <div className="bulk-multi-filter-menu">
          <div className="bulk-multi-filter-search">
            <input autoFocus className="field" onChange={(event) => setTerm(event.target.value)} placeholder={`Search ${label.toLowerCase()}`} value={term} />
          </div>
          <label className="bulk-multi-filter-option all">
            <input checked={filteredOptions.length > 0 && filteredOptions.every((option) => selectedSet.has(option.value))} onChange={toggleAll} type="checkbox" />
            <span>Check shown</span>
            <small>{filteredOptions.length} of {options.length}</small>
          </label>
          <div className="bulk-multi-filter-options">
            {filteredOptions.length ? filteredOptions.map((option) => (
              <label className="bulk-multi-filter-option" key={option.value}>
                <input checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
                <span>{option.label}</span>
                {option.helper ? <small>{option.helper}</small> : null}
              </label>
            )) : <p className="subtle">No items available.</p>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function BulkWhatsAppPanel({
  canSend,
  campaignError,
  campaigns,
  contacts,
  defaultCountryCode,
  flash,
  profiles,
  templates,
  whatsAppEnabled
}: {
  canSend: boolean;
  campaignError: string | null;
  campaigns: Campaign[];
  contacts: Contact[];
  defaultCountryCode: string;
  flash: { error: string | null; notice: string | null };
  profiles: WhatsAppProfile[];
  templates: Template[];
  whatsAppEnabled: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isHistoryRefreshing, startHistoryRefresh] = useTransition();
  const [sourceMode, setSourceMode] = useState<"database" | "excel">("database");
  const [selectedProfileId, setSelectedProfileId] = useState(profiles.find((profile) => profile.id === searchParams.get("profile"))?.id ?? profiles.find((profile) => profile.is_default)?.id ?? profiles[0]?.id ?? "");
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates.find((template) => template.template_id === searchParams.get("template") && template.whatsapp_profile_id === searchParams.get("profile") && template.status === "APPROVED")?.template_id ?? "");
  const [mappings, setMappings] = useState<Record<string, MappingRule>>({});
  const [constantMappings, setConstantMappings] = useState<Record<string, string>>({});
  const [templateHeaderFile, setTemplateHeaderFile] = useState<File | null>(null);
  const [search, setSearch] = useState("");
  const [contactSources, setContactSources] = useState<string[]>([]);
  const [contactStatuses, setContactStatuses] = useState<string[]>(["active"]);
  const [contactLocations, setContactLocations] = useState<string[]>([]);
  const [contactProviders, setContactProviders] = useState<string[]>([]);
  const [contactModels, setContactModels] = useState<string[]>([]);
  const [contactRoles, setContactRoles] = useState<string[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [sendListIds, setSendListIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [excelHeaders, setExcelHeaders] = useState<string[]>([]);
  const [excelRows, setExcelRows] = useState<Record<string, unknown>[]>([]);
  const [excelMobileHeader, setExcelMobileHeader] = useState("");
  const [countryCodeMode, setCountryCodeMode] = useState<CountryCodeMode>("default");
  const [countryCodeHeader, setCountryCodeHeader] = useState("");
  const [countryCodeConstant, setCountryCodeConstant] = useState("");
  const [localFlash, setLocalFlash] = useState(flash);
  const [historyOpen, setHistoryOpen] = useState(() => searchParams.get("history") === "1");
  const [progress, setProgress] = useState<ProgressState>({
    open: false,
    phase: "confirm",
    total: 0,
    current: 0,
    sent: 0,
    failed: 0,
    message: ""
  });
  const formRef = useRef<HTMLFormElement | null>(null);
  const campaignWakeInFlightRef = useRef(false);

  function setHistoryModalOpen(open: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (open) {
      params.set("history", "1");
    } else {
      params.delete("history");
    }
    const query = params.toString();
    setHistoryOpen(open);
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function refreshHistory() {
    startHistoryRefresh(() => router.refresh());
  }

  function openHistory() {
    setHistoryModalOpen(true);
    refreshHistory();
  }

  useEffect(() => {
    setHistoryOpen(searchParams.get("history") === "1");
  }, [searchParams]);

  const selectedTemplate = templates.find((template) => template.template_id === selectedTemplateId && template.whatsapp_profile_id === selectedProfileId) ?? null;
  const variables = useMemo(() => extractWhatsAppTemplateVariables(selectedTemplate?.components ?? []), [selectedTemplate]);
  const templateHeaderMediaType = useMemo(() => getWhatsAppTemplateHeaderMediaType(selectedTemplate?.components ?? []), [selectedTemplate]);
  const approvedTemplates = templates.filter((template) => template.status === "APPROVED" && template.whatsapp_profile_id === selectedProfileId);
  const templateOptions = approvedTemplates.map((template) => ({
    value: template.template_id,
    label: `${template.name} (${template.language})`,
    helper: `${template.category ?? "Uncategorised"}`
  }));
  const profileOptions = profiles.map((profile) => ({
    value: profile.id,
    label: profile.profile_name,
    helper: `${profile.phone_number_id} - ${profile.default_country_code}`
  }));
  const excelFieldOptions = excelHeaders.map((header) => ({ value: header, label: header }));
  const fieldOptions = sourceMode === "excel" ? excelFieldOptions : databaseFieldOptions;
  const sourceOptions = [
    { value: "Dashboard User", label: "Dashboard Users" },
    { value: "Employee", label: "Employees" },
    { value: "Field Executive", label: "Field Executives" },
    { value: "Independent Contractor", label: "Independent Contractors" },
    { value: "Vendor", label: "Vendors" },
    { value: "Worker", label: "Workers" }
  ];
  const statusOptions = uniqueOptions(contacts.map((contact) => contact.status)).map((status) => ({ value: status.toLowerCase(), label: status }));
  const locationOptions = uniqueOptions(contacts.flatMap((contact) => contact.location.split(",").map((item) => item.trim()))).map((location) => ({ value: location, label: location }));
  const providerOptions = uniqueOptions(contacts.flatMap((contact) => (contact.provider ?? "").split(",").map((item) => item.trim()))).map((provider) => ({ value: provider, label: provider }));
  const modelOptions = uniqueOptions(contacts.flatMap((contact) => (contact.model ?? "").split(",").map((item) => item.trim()))).map((model) => ({ value: model, label: model }));
  const roleOptions = uniqueOptions(contacts.map((contact) => contact.designation || contact.role)).map((role) => ({ value: role, label: role }));
  const effectiveMappings = useMemo(() => {
    const merged: Record<string, MappingRule> = {};
    const keys = new Set([...variables.map((variable) => variable.key), ...Object.keys(mappings), ...Object.keys(constantMappings)]);
    keys.forEach((key) => {
      const constantValue = constantMappings[key] ?? "";
      const fieldValue = mappings[key]?.value ?? "";
      if (constantValue.trim()) merged[key] = { mode: "constant", value: constantValue };
      else if (fieldValue) merged[key] = { mode: "field", value: fieldValue };
    });
    return merged;
  }, [constantMappings, mappings, variables]);
  const preview = buildTemplatePreview(selectedTemplate, effectiveMappings);
  const hasPendingCampaigns = campaigns.some((campaign) => campaign.pending_count > 0 || campaign.status === "queued" || campaign.status === "processing");

  useEffect(() => {
    if (!historyOpen || !hasPendingCampaigns) return;
    let cancelled = false;

    async function wakeCampaignProcessor() {
      if (campaignWakeInFlightRef.current) return;
      campaignWakeInFlightRef.current = true;
      try {
        await fetch("/api/whatsapp/process-campaigns", { method: "POST" });
        if (!cancelled) router.refresh();
      } finally {
        campaignWakeInFlightRef.current = false;
      }
    }

    void wakeCampaignProcessor();
    const interval = window.setInterval(() => void wakeCampaignProcessor(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hasPendingCampaigns, historyOpen, router]);

  const filteredContacts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return contacts.filter((contact) => {
      const searchable = `${contact.name} ${contact.mobile} ${contact.email} ${contact.dropx_id ?? ""} ${contact.location} ${contact.provider ?? ""} ${contact.model ?? ""} ${contact.role} ${contact.designation ?? ""}`.toLowerCase();
      const matchesSearch = !term || searchable.includes(term);
      const contactLocationList = contact.location.split(",").map((item) => item.trim()).filter(Boolean);
      const contactProviderList = (contact.provider ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      const contactModelList = (contact.model ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      const matchesSource = !contactSources.length || contactSources.includes(contact.source);
      const matchesStatus = !contactStatuses.length || contactStatuses.includes(contact.status.toLowerCase());
      const matchesLocation = !contactLocations.length || contactLocationList.some((location) => contactLocations.includes(location));
      const matchesProvider = !contactProviders.length || contactProviderList.some((provider) => contactProviders.includes(provider));
      const matchesModel = !contactModels.length || contactModelList.some((model) => contactModels.includes(model));
      const roleValue = contact.designation || contact.role;
      const matchesRole = !contactRoles.length || contactRoles.includes(roleValue);
      return matchesSearch && matchesSource && matchesStatus && matchesLocation && matchesProvider && matchesModel && matchesRole;
    });
  }, [contactLocations, contactModels, contactProviders, contactRoles, contactSources, contactStatuses, contacts, search]);
  const totalPages = Math.max(1, Math.ceil(filteredContacts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleContacts = filteredContacts.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const checkedContacts = contacts.filter((contact) => checkedIds.has(contact.id));
  const sendListContacts = contacts.filter((contact) => sendListIds.has(contact.id));
  const canSubmit = Boolean(canSend && whatsAppEnabled && selectedProfileId && selectedTemplate && (
    sourceMode === "excel" ? excelRows.length > 0 && excelMobileHeader : sendListContacts.length > 0
  ));

  function setMapping(variableKey: string, value: string) {
    setMappings((current) => ({
      ...current,
      [variableKey]: { mode: "field", value }
    }));
    if (value) {
      setConstantMappings((current) => ({
        ...current,
        [variableKey]: ""
      }));
    }
  }

  function setConstantMapping(variableKey: string, value: string) {
    setConstantMappings((current) => ({
      ...current,
      [variableKey]: value
    }));
    if (value.trim()) {
      setMappings((current) => ({
        ...current,
        [variableKey]: { mode: "field", value: "" }
      }));
    }
  }

  async function readExcel(file: File | null) {
    setExcelHeaders([]);
    setExcelRows([]);
    setExcelMobileHeader("");
    setCountryCodeHeader("");
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    setExcelRows(rows);
    setExcelHeaders(rows[0] ? Object.keys(rows[0]) : []);
  }

  function updateFilters(callback: () => void) {
    callback();
    setPage(1);
  }

  function toggleContact(id: string) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleContacts() {
    setCheckedIds((current) => {
      const next = new Set(current);
      const allVisibleSelected = visibleContacts.every((contact) => next.has(contact.id));
      visibleContacts.forEach((contact) => {
        if (allVisibleSelected) next.delete(contact.id);
        else next.add(contact.id);
      });
      return next;
    });
  }

  function checkCurrentPage() {
    setCheckedIds((current) => new Set([...current, ...visibleContacts.map((contact) => contact.id)]));
  }

  function checkAllFiltered() {
    setCheckedIds((current) => new Set([...current, ...filteredContacts.map((contact) => contact.id)]));
  }

  function addCheckedToSendList() {
    setSendListIds((current) => {
      const next = new Set(current);
      checkedIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function clearSendList() {
    setSendListIds(new Set());
    setCheckedIds(new Set());
  }

  function removeFromSendList(id: string) {
    setSendListIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function excelRecipients(): BulkSendRecipient[] {
    return excelRows.map((row, index) => {
      const countryCode =
        countryCodeMode === "excel"
          ? String(row[countryCodeHeader] ?? "")
          : countryCodeMode === "constant"
            ? countryCodeConstant
            : String(row.country_code ?? row.CountryCode ?? row["Country Code"] ?? row.countryCode ?? "");
      return {
        id: `excel-${index + 1}`,
        source: "Excel upload",
        ...row,
        mobile: String(row[excelMobileHeader] ?? ""),
        country_code: countryCode
      };
    });
  }

  function recipientsForSend(): BulkSendRecipient[] {
    const recipients: BulkSendRecipient[] = sourceMode === "excel" ? excelRecipients() : sendListContacts;
    return recipients
      .filter((recipient) => String(recipient.mobile ?? "").trim());
  }

  function validateBeforeConfirm() {
    if (!formRef.current?.reportValidity()) return false;
    if (!canSubmit) {
      setLocalFlash({ error: "Select a WhatsApp profile, recipients, and an approved template.", notice: null });
      return false;
    }
    const missing = variables.filter((variable) => !effectiveMappings[variable.key]?.value);
    if (missing.length) {
      setLocalFlash({ error: `Map all template variables: ${missing.map((item) => item.label).join(", ")}.`, notice: null });
      return false;
    }
    if (templateHeaderMediaType && !templateHeaderFile) {
      setLocalFlash({ error: `Upload the ${templateHeaderMediaType} required by the selected template header.`, notice: null });
      return false;
    }
    if (sourceMode === "excel") {
      if (countryCodeMode === "excel" && !countryCodeHeader) {
        setLocalFlash({ error: "Select the Excel column that contains country codes.", notice: null });
        return false;
      }
      if (countryCodeMode === "constant" && !countryCodeConstant.trim()) {
        setLocalFlash({ error: "Enter the constant country code.", notice: null });
        return false;
      }
    }
    const recipients = recipientsForSend();
    if (!recipients.length) {
      setLocalFlash({ error: "No valid mobile numbers found.", notice: null });
      return false;
    }
    if (recipients.length > maxCampaignRecipients) {
      setLocalFlash({ error: `Maximum ${maxCampaignRecipients.toLocaleString("en-IN")} recipients allowed per campaign.`, notice: null });
      return false;
    }
    return true;
  }

  function openSendConfirmation() {
    if (!validateBeforeConfirm()) return;
    const total = recipientsForSend().length;
    setLocalFlash({ error: null, notice: null });
    setProgress({
      open: true,
      phase: "confirm",
      total,
      current: 0,
      sent: 0,
      failed: 0,
      message: `Send ${total} WhatsApp message${total === 1 ? "" : "s"} now?`
    });
  }

  async function startProgressSend() {
    const recipients = recipientsForSend();
    setProgress((current) => ({ ...current, phase: "sending", total: recipients.length, current: 0, sent: 0, failed: 0, message: "Creating campaign..." }));
    try {
      const formData = new FormData();
      formData.set("sourceMode", sourceMode);
      formData.set("templateId", selectedTemplateId);
      formData.set("whatsappProfileId", selectedProfileId);
      formData.set("mappings", JSON.stringify(effectiveMappings));
      formData.set("recipients", JSON.stringify(recipients));
      if (templateHeaderFile) formData.set("headerMediaFile", templateHeaderFile);
      const response = await fetch("/api/whatsapp/campaigns", { method: "POST", body: formData });
      const payload = await response.json() as { campaignCode?: string; total?: number; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error || "Unable to create WhatsApp campaign.");
      setProgress((current) => ({
        ...current,
        current: 0,
        campaignCode: payload.campaignCode,
        message: `Campaign ${payload.campaignCode} created. Background sending started.`
      }));
      setProgress((current) => ({
        ...current,
        phase: "done",
        message: `Campaign ${payload.campaignCode} queued. It will continue in background if the browser is closed.`
      }));
      setLocalFlash({ error: null, notice: `Campaign ${payload.campaignCode} created for ${payload.total ?? recipients.length} contacts.` });
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create WhatsApp campaign.";
      setProgress((current) => ({
        ...current,
        phase: "done",
        message
      }));
      setLocalFlash({ error: message, notice: null });
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openSendConfirmation();
  }

  return (
    <>
    <form className="bulk-whatsapp-page" onSubmit={handleSubmit} ref={formRef}>
      {localFlash.error || localFlash.notice ? (
        <section className={`panel message-panel ${localFlash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{localFlash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{localFlash.error ?? localFlash.notice}</p>
          </div>
        </section>
      ) : null}

      {!whatsAppEnabled ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>WhatsApp is disabled</strong>
            <p className="subtle" style={{ marginTop: 6 }}>Enable WhatsApp notifications in Settings before sending bulk messages.</p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Bulk WhatsApp notifications</h2>
            <p className="subtle">Select recipients from existing data or upload an Excel file, then map template variables.</p>
          </div>
          <div className="panel-head-actions">
            <a className="button secondary" href="/notifications/whatsapp/templates">Templates · Create / manage</a>
            <button className="button secondary history-button" onClick={openHistory} type="button">History</button>
            {whatsAppEnabled ? <span className="status-pill good">Enabled</span> : null}
          </div>
        </div>
        <div className="bulk-source-switch">
          <label className={sourceMode === "database" ? "active" : ""}>
            <input checked={sourceMode === "database"} name="source_mode_choice" onChange={() => setSourceMode("database")} type="radio" />
            Existing data
          </label>
          <label className={sourceMode === "excel" ? "active" : ""}>
            <input checked={sourceMode === "excel"} name="source_mode_choice" onChange={() => setSourceMode("excel")} type="radio" />
            Excel upload
          </label>
        </div>
        <input name="source_mode" type="hidden" value={sourceMode} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>1. Choose your template</h2>
            <p className="subtle">Use a recipient field, Excel column, or constant value for each WhatsApp variable.</p>
          </div>
        </div>
        <div className="bulk-template-layout">
          <div>
            <div className="bulk-template-grid">
              <label>Send from profile
                <SearchableSelect
                  name="whatsapp_profile_id"
                  onValueChange={(value) => {
                    setSelectedProfileId(value);
                    setSelectedTemplateId("");
                    setMappings({});
                    setConstantMappings({});
                    setTemplateHeaderFile(null);
                  }}
                  options={profileOptions}
                  placeholder={profiles.length ? "Select WhatsApp profile" : "Add profile in settings"}
                  required
                  value={selectedProfileId}
                />
              </label>
              <label>WhatsApp template
                <SearchableSelect
                  disabled={!selectedProfileId}
                  name="template_id"
                  onValueChange={(value) => {
                    if (value === selectedTemplateId) return;
                    setSelectedTemplateId(value);
                    setMappings({});
                    setConstantMappings({});
                    setTemplateHeaderFile(null);
                  }}
                  options={templateOptions}
                  placeholder={!selectedProfileId ? "Select profile first" : approvedTemplates.length ? "Search approved template" : "No approved templates for selected profile"}
                  required
                  value={selectedTemplateId}
                />
              </label>
              {sourceMode === "excel" ? (
                <>
                  <div className="bulk-country-code-grid">
                    <label>Country code source
                      <select className="select" name="country_code_mode" onChange={(event) => setCountryCodeMode(event.target.value as CountryCodeMode)} value={countryCodeMode}>
                        <option value="default">Default ({defaultCountryCode || "91"})</option>
                        <option value="excel">Excel column</option>
                        <option value="constant">Constant</option>
                      </select>
                    </label>
                    {countryCodeMode === "excel" ? (
                      <label>Country code column
                        <SearchableSelect name="country_code_header" onValueChange={setCountryCodeHeader} options={excelFieldOptions} placeholder="Select country code column" required value={countryCodeHeader} />
                      </label>
                    ) : null}
                    {countryCodeMode === "constant" ? (
                      <label>Country code value
                        <input className="field" name="country_code_constant" onChange={(event) => setCountryCodeConstant(event.target.value)} placeholder="91" required value={countryCodeConstant} />
                      </label>
                    ) : null}
                    {countryCodeMode !== "excel" ? <input name="country_code_header" type="hidden" value={countryCodeHeader} /> : null}
                    {countryCodeMode !== "constant" ? <input name="country_code_constant" type="hidden" value={countryCodeConstant} /> : null}
                  </div>
                  <label className="bulk-mobile-column-field">Mobile number column
                    <select
                      className="select"
                      name="excel_mobile_header"
                      onChange={(event) => setExcelMobileHeader(event.target.value)}
                      required={sourceMode === "excel"}
                      value={excelMobileHeader}
                    >
                      <option value="">Select Mobile No Column</option>
                      {excelHeaders.map((header) => (
                        <option key={header} value={header}>{header}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <input name="country_code_mode" type="hidden" value="default" />
                  <input name="country_code_header" type="hidden" value="" />
                  <input name="country_code_constant" type="hidden" value="" />
                </>
              )}
              {templateHeaderMediaType ? (
                <label className="bulk-mobile-column-field">{`Header ${templateHeaderMediaType}`}
                  <input
                    accept={acceptsForHeaderMedia(templateHeaderMediaType)}
                    className="field"
                    onChange={(event) => setTemplateHeaderFile(event.target.files?.[0] ?? null)}
                    required
                    type="file"
                  />
                  <span className="subtle">Required by this template header. It will be uploaded once and used for all recipients in the campaign.</span>
                </label>
              ) : null}
            </div>

            {variables.length ? (
              <div className="bulk-variable-grid">
                {variables.map((variable) => {
                  const fieldValue = mappings[variable.key]?.value ?? "";
                  const constantValue = constantMappings[variable.key] ?? "";
                  const hasFieldValue = Boolean(fieldValue);
                  const hasConstantValue = Boolean(constantValue.trim());
                  return (
                    <div className="bulk-variable-row" key={variable.key}>
                      <div>
                        <strong>{variable.label}</strong>
                        <span className="subtle">{variable.component}</span>
                      </div>
                      <div className="bulk-variable-fields">
                        <div>
                          <span className="bulk-variable-label">{sourceMode === "excel" ? "Excel column" : "Recipient field"}</span>
                          <select
                            className="select"
                            disabled={hasConstantValue}
                            name={`ui_mapping_${variable.key}`}
                            value={hasConstantValue ? "" : fieldValue}
                            onChange={(event) => setMapping(variable.key, event.target.value)}
                          >
                            <option value="">{hasConstantValue ? "Using constant value" : sourceMode === "excel" ? "Select Excel column" : "Select recipient field"}</option>
                            {fieldOptions.map((option) => (
                              <option key={`${variable.key}-${option.value}`} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <span className="bulk-variable-label">Constant value</span>
                          <input
                            className="field"
                            disabled={hasFieldValue}
                            onChange={(event) => setConstantMapping(variable.key, event.target.value)}
                            placeholder={hasFieldValue ? "Using selected field" : "Enter fixed value"}
                            value={hasFieldValue ? "" : constantValue}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="panel-body"><p className="subtle">{selectedTemplate ? "This template has no variables." : "Select a template to map variables."}</p></div>
            )}
          </div>
          <aside className="bulk-template-preview">
            <span className="subtle">Template preview</span>
            <TemplateMediaPreview file={templateHeaderFile} type={templateHeaderMediaType} />
            {preview.header ? <h3>{preview.header}</h3> : null}
            <p>{preview.body}</p>
            {preview.buttons.length ? (
              <div className="bulk-preview-buttons">
                {preview.buttons.map((button) => <span key={button}>{button}</span>)}
              </div>
            ) : null}
          </aside>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head toolbar">
          <div>
            <h2>{sourceMode === "database" ? "2. Choose recipients" : "2. Upload recipients"}</h2>
            <p className="subtle">
              {sourceMode === "database"
                ? `${sendListContacts.length} in send list, ${checkedContacts.length} selected`
                : `${excelRows.length} rows loaded`}
            </p>
          </div>
          {sourceMode === "database" ? (
            <div className="bulk-recipient-filters">
              <input className="field" onChange={(event) => updateFilters(() => setSearch(event.target.value))} placeholder="Search ID, name, mobile, email" value={search} />
              <MultiCheckFilter label="All data" onChange={(values) => updateFilters(() => setContactSources(values))} options={sourceOptions} selected={contactSources} />
              <MultiCheckFilter label="All providers" onChange={(values) => updateFilters(() => setContactProviders(values))} options={providerOptions} selected={contactProviders} />
              <MultiCheckFilter label="All models" onChange={(values) => updateFilters(() => setContactModels(values))} options={modelOptions} selected={contactModels} />
              <MultiCheckFilter label="All locations" onChange={(values) => updateFilters(() => setContactLocations(values))} options={locationOptions} selected={contactLocations} />
              <MultiCheckFilter label="All designations" onChange={(values) => updateFilters(() => setContactRoles(values))} options={roleOptions} selected={contactRoles} />
              <MultiCheckFilter label="All statuses" onChange={(values) => updateFilters(() => setContactStatuses(values))} options={statusOptions} selected={contactStatuses} />
            </div>
          ) : (
            <input
              accept=".xlsx,.xls,.csv"
              className="field bulk-file-input"
              name="bulk_file"
              onChange={(event) => void readExcel(event.target.files?.[0] ?? null)}
              required={sourceMode === "excel"}
              type="file"
            />
          )}
        </div>

        {sourceMode === "database" ? (
          <>
            <div className="bulk-list-actions">
              <div className="bulk-filter-counts">
                <strong>{filteredContacts.length}</strong> filtered
                <span>{visibleContacts.length} on page</span>
                <span>{checkedContacts.length} selected</span>
              </div>
              <button className="button ghost compact" disabled={!visibleContacts.length} onClick={checkCurrentPage} type="button">Select Current</button>
              <button className="button ghost compact" disabled={!filteredContacts.length} onClick={checkAllFiltered} type="button">Select All Filtered</button>
              <button className="button secondary compact" disabled={!checkedIds.size} onClick={addCheckedToSendList} type="button">Add to list</button>
              <button className="button ghost compact" disabled={!sendListIds.size && !checkedIds.size} onClick={clearSendList} type="button">Clear</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th><input aria-label="Select visible recipients" checked={visibleContacts.length > 0 && visibleContacts.every((contact) => checkedIds.has(contact.id))} onChange={toggleVisibleContacts} type="checkbox" /></th>
                    <th>Name</th>
                    <th>Mobile</th>
                    <th>Source</th>
                    <th>Location</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleContacts.length ? visibleContacts.map((contact) => (
                    <tr key={contact.id}>
                      <td><input checked={checkedIds.has(contact.id)} onChange={() => toggleContact(contact.id)} type="checkbox" /></td>
                      <td>
                        <strong>{contact.name}</strong><br />
                        <span className="subtle">
                          {[contact.dropx_id, contact.email].filter(Boolean).join(" · ") || "-"}
                        </span>
                      </td>
                      <td>{displayMobile(contact.mobile, contact.country_code)}</td>
                      <td>
                        <strong>{contact.source}</strong><br />
                        <span className="subtle">{contact.designation || contact.role || "-"}</span>
                      </td>
                      <td>{contact.location || "-"}</td>
                      <td>{contact.status}</td>
                    </tr>
                  )) : <tr><td className="empty-cell" colSpan={6}>No contacts found.</td></tr>}
                </tbody>
              </table>
            </div>
            {totalPages > 1 ? (
              <div className="panel-foot pagination">
                <button className="pager-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} type="button">Prev</button>
                <span>Page {currentPage} of {totalPages}</span>
                <button className="pager-button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button>
              </div>
            ) : null}
            <div className="bulk-send-list">
              <div className="bulk-send-list-head">
                <strong>Send list</strong>
                <span className="subtle">{sendListContacts.length} contact{sendListContacts.length === 1 ? "" : "s"}</span>
              </div>
              {sendListContacts.length ? (
                <div className="bulk-send-list-tags">
                  {sendListContacts.map((contact) => (
                    <button key={contact.id} onClick={() => removeFromSendList(contact.id)} title="Remove from send list" type="button">
                      <span>{contact.name}</span>
                      <small>{contact.mobile}</small>
                      <strong>x</strong>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="subtle">Select contacts above and click Add to list.</p>
              )}
            </div>
          </>
        ) : (
          <div className="panel-body bulk-excel-summary">
            <div><span className="subtle">Detected headers</span><strong>{excelHeaders.length ? excelHeaders.join(", ") : "Upload a file to detect headers"}</strong></div>
            <div><span className="subtle">Required</span><strong>Mobile number column, country code rule, and any variable columns used by the template</strong></div>
          </div>
        )}
      </section>


      <input name="variable_mappings_json" type="hidden" value={JSON.stringify(effectiveMappings)} />
      <input name="selected_recipients_json" type="hidden" value={JSON.stringify(sendListContacts)} />
      <div className="bulk-submit-row">
        <button
          className="button"
          disabled={!canSubmit}
          type="submit"
        >
          {canSubmit ? "Send WhatsApp" : "Select recipients and template"}
        </button>
      </div>

      {progress.open ? (
        <div className="modal-backdrop confirmation-backdrop">
          <section aria-modal="true" className="modal-panel confirmation-dialog bulk-progress-dialog" role="alertdialog">
            <div className="panel-head">
              <div>
                <h2>{progress.phase === "confirm" ? "Confirm bulk WhatsApp" : progress.phase === "sending" ? "Creating campaign" : "Campaign queued"}</h2>
                <p className="subtle">
                  {progress.phase === "confirm"
                    ? "A campaign will be created and processed from the backend."
                    : "Sending will continue in background after the campaign is created."}
                </p>
              </div>
            </div>
            <div className="confirmation-body bulk-progress-body">
              {progress.phase === "confirm" ? (
                <p>{progress.message}</p>
              ) : (
                <>
                  <div className="bulk-progress-count">{progress.campaignCode ?? `${progress.current}/${progress.total}`}</div>
                  <div className="bulk-progress-track">
                    <span style={{ width: progress.phase === "done" ? "100%" : "35%" }} />
                  </div>
                  <div className="bulk-progress-stats">
                    <span>Total: {progress.total}</span>
                    <span>Status: {progress.phase === "done" ? "Queued" : "Creating"}</span>
                  </div>
                  <p className="subtle">{progress.message}</p>
                </>
              )}
            </div>
            <div className="form-actions modal-actions confirmation-actions">
              {progress.phase === "confirm" ? (
                <>
                  <button className="button secondary" onClick={() => setProgress((current) => ({ ...current, open: false }))} type="button">Cancel</button>
                  <button className="button" onClick={() => void startProgressSend()} type="button">Confirm send</button>
                </>
              ) : progress.phase === "done" ? (
                <button className="button" onClick={() => setProgress((current) => ({ ...current, open: false }))} type="button">Close</button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </form>
    {historyOpen ? (
      <div className="modal-backdrop confirmation-backdrop">
        <section aria-modal="true" className="modal-panel campaign-history-modal" role="dialog">
          <button aria-label="Close history" className="modal-close" onClick={() => setHistoryModalOpen(false)} type="button">x</button>
          <CampaignReport campaignError={campaignError} campaigns={campaigns} isRefreshing={isHistoryRefreshing} onRefresh={refreshHistory} />
        </section>
      </div>
    ) : null}
    </>
  );
}

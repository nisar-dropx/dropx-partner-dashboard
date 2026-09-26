"use client";

import { FleetReports } from "@/components/fleet-daily-report";
import { Activity, Download, Eye, Fuel, Gauge, MoreVertical, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SearchableSelect, type SearchableSelectOption } from "@/components/searchable-select";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";

type FleetMetric = {
  vehicle_no: string;
  station_code: string;
  rc_location?: string;
  model: string;
  fuel_type: string;
  registration_expiry?: string;
  insurance_expiry?: string;
  puc_expiry?: string;
  fitness_expiry?: string;
  tax_expiry?: string;
  status?: string;
  transfer_date?: string;
  sale_date?: string;
  dispose_date?: string;
  km: number;
  litres: number;
  fuelAmount: number;
  maintenanceAmount?: number;
  txns?: number;
  alerts: string[];
  mileage: number;
  costPerKm: number;
  healthScore: number;
};

type FuelRow = {
  transaction_at?: string;
  vehicle_no: string;
  station_code: string;
  source: string;
  pump_name?: string;
  quantity: number;
  amount: number;
  rate?: number;
};

type FuelProvider = "IOC" | "BPCL";
type FuelReportType = "transactions" | "vehicle" | "location";

type GpsRow = {
  vehicle_no: string;
  speed: number;
  ignition: boolean;
  gps_time?: string;
  latitude: number;
  longitude: number;
};

type MaintenanceRow = {
  date: string;
  vehicle_no: string;
  issue_type: string;
  amount: number;
  vendor?: string;
  bill_url?: string;
};

type FleetSummary = {
  error?: string;
  fuelError?: string | null;
  dailyKmError?: string | null;
  generatedAt?: string;
  source?: string;
  vehicleMetrics?: FleetMetric[];
  locations?: FleetLocation[];
  documentTypes?: FleetDocumentDefinition[];
  fuel?: FuelRow[];
  gpsLive?: GpsRow[];
  maintenance?: MaintenanceRow[];
  vehicles?: unknown[];
};

type FleetLocation = {
  code: string;
  name: string | null;
  provider: string;
  model: string;
};

type FleetAction = "add" | "edit" | "transfer" | "renewal" | "sale" | "dispose";
type FleetDocumentType = string;
type FleetDocumentDefinition = {
  value: FleetDocumentType;
  label: string;
  requires_expiry?: boolean;
  reminder_days?: number;
  sort_order?: number;
};
type FleetDocumentRecord = {
  document_type: FleetDocumentType;
  file_name: string;
  content_type?: string | null;
  file_size?: number | null;
  expiry_date?: string | null;
  uploaded_at?: string | null;
  signed_url?: string | null;
  download_url?: string | null;
};

type FleetVehicleForm = {
  vehicle_no: string;
  station_code: string;
  rc_location: string;
  model: string;
  fuel_type: string;
  registration_expiry: string;
  insurance_expiry: string;
  puc_expiry: string;
  fitness_expiry: string;
  tax_expiry: string;
  status: string;
  transfer_date: string;
  sale_date: string;
  dispose_date: string;
};

type RouteHistory = {
  error?: string;
  points?: { lat: number; lng: number }[];
  summary?: {
    km: number;
    maxSpeed: number;
    movingMinutes: number;
    pointCount: number;
    lateNight: boolean;
    distanceReliable?: boolean;
    quality?: string;
    qualityReason?: string;
    rawKm?: number;
  };
};

const modes = ["Action Center", "Vehicles", "Documents", "Station View", "Tracking", "Fuel Log", "Live GPS", "Maintenance", "Report"];
const fleetTabSlugs: Record<string, string> = {
  "Action Center": "action-center",
  Vehicles: "vehicle-view",
  Documents: "date-view",
  "Station View": "station-view",
  Tracking: "tracking",
  "Fuel Log": "fuel-log",
  "Live GPS": "live-gps",
  Maintenance: "maintenance",
  Report: "report"
};
type FleetTabPermission = { canView: boolean; canAdd: boolean; canEdit: boolean };
type FleetManager = { email: string | null; name: string };

export function FleetDashboard({
  canAddVehicle = false,
  canEditFleet = false,
  fleetManager,
  initialMode,
  tabPermissions = {}
}: {
  canAddVehicle?: boolean;
  canEditFleet?: boolean;
  fleetManager?: FleetManager | null;
  initialMode?: string;
  tabPermissions?: Record<string, FleetTabPermission>;
}) {
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  const [mode, setMode] = useState(initialMode ?? "Action Center");
  const [vehicle, setVehicle] = useState("ALL");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [route, setRoute] = useState<RouteHistory | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [vehicleModal, setVehicleModal] = useState<{ action: FleetAction; vehicle?: FleetMetric; documentType?: FleetDocumentType; documentIntent?: "view" | "change"; canEdit?: boolean } | null>(null);
  const [savingVehicle, setSavingVehicle] = useState(false);
  const [fleetFlash, setFleetFlash] = useState<{ error?: string; notice?: string } | null>(null);

  useEffect(() => {
    refreshFleet();
  }, []);

  const visibleModes = useMemo(() => modes.filter((item) => tabPermissions[item]?.canView), [tabPermissions]);

  useEffect(() => {
    if (visibleModes.length && !visibleModes.includes(mode)) setMode(visibleModes[0]);
  }, [mode, visibleModes]);

  function changeMode(nextMode: string) {
    setMode(nextMode);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", fleetTabSlugs[nextMode] ?? nextMode.toLowerCase().replace(/\s+/g, "-"));
    window.history.pushState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
  }

  function refreshFleet() {
    return fetch(`/api/fleet/summary?ts=${Date.now()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then(setSummary)
      .catch((error) => setSummary({ error: error.message }));
  }

  const metrics = summary?.vehicleMetrics ?? [];
  const mappedRows = metrics.filter((row) => row.vehicle_no !== "UNALLOCATED");
  const fuelRows = summary?.fuel ?? [];
  const documentTypes = normalizeDocumentTypes(summary?.documentTypes);
  const liveVehicleSet = new Set((summary?.gpsLive ?? []).map((row) => row.vehicle_no));
  const liveTrackedRows = metrics.filter((row) => liveVehicleSet.has(row.vehicle_no));
  const totals = {
    vehicles: mappedRows.length,
    km: sum(mappedRows, "km"),
    litres: sum(mappedRows, "litres"),
    fuel: sum(mappedRows, "fuelAmount")
  };
  const mileage = totals.litres ? totals.km / totals.litres : 0;
  const costKm = totals.km ? totals.fuel / totals.km : 0;

  async function openTracking(nextVehicle: string) {
    if (!nextVehicle) return;
    setVehicle(nextVehicle);
    changeMode("Tracking");
    setRouteLoading(true);
    setRoute(null);
    try {
      const response = await fetch(`/api/wheelseye/history?vehicle=${encodeURIComponent(nextVehicle)}&date=${encodeURIComponent(date)}`);
      setRoute(await response.json());
    } catch (error) {
      setRoute({ error: error instanceof Error ? error.message : "Unable to load movement." });
    } finally {
      setRouteLoading(false);
    }
  }

  async function submitVehicle(
    action: FleetAction,
    form: FleetVehicleForm,
    documents?: Partial<Record<FleetDocumentType, File | null>>,
    documentExpiries?: Partial<Record<FleetDocumentType, string>>
  ) {
    setSavingVehicle(true);
    setFleetFlash(null);
    try {
      const method = action === "add" ? "POST" : "PATCH";
      const requestBody: Record<string, string> = {
        ...form,
        status: action === "sale" ? "sold" : action === "dispose" ? "disposed" : form.status
      };
      if (action !== "transfer") delete requestBody.transfer_date;
      if (action !== "sale") delete requestBody.sale_date;
      if (action !== "dispose") delete requestBody.dispose_date;
      if (action === "edit") {
        delete requestBody.registration_expiry;
        delete requestBody.insurance_expiry;
        delete requestBody.puc_expiry;
        delete requestBody.fitness_expiry;
        delete requestBody.tax_expiry;
      }
      const response = await fetch("/api/fleet/vehicles", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Vehicle update failed.");
      const selectedDocuments = Object.entries(documents ?? {}).filter(([, file]) => file) as Array<[FleetDocumentType, File]>;
      for (const [documentType, file] of selectedDocuments) {
        const documentPayload = new FormData();
        documentPayload.append("vehicle_no", form.vehicle_no);
        documentPayload.append("document_type", documentType);
        const field = documentExpiryField(documentType);
        documentPayload.append("expiry_date", normalizeOptionalDate(documentExpiries?.[documentType] ?? (field ? form[field] : "")));
        documentPayload.append("file", file);
        const documentResponse = await fetch("/api/fleet/documents", {
          method: "POST",
          body: documentPayload
        });
        const documentResult = await documentResponse.json().catch(() => ({}));
        if (!documentResponse.ok) throw new Error(documentResult.error || "Document upload failed.");
      }
      setVehicleModal(null);
      setFleetFlash({ notice: selectedDocuments.length ? "Vehicle and documents saved." : action === "sale" ? "Vehicle marked as sold." : action === "dispose" ? "Vehicle marked as disposed." : "Vehicle saved." });
      refreshFleet();
    } catch (error) {
      setFleetFlash({ error: error instanceof Error ? error.message : "Vehicle update failed." });
    } finally {
      setSavingVehicle(false);
    }
  }

  if (!summary) {
    return (
      <FleetFrame fleetManager={fleetManager}>
        <div className="fleet-empty">Loading fleet data...</div>
      </FleetFrame>
    );
  }

  if (summary.error) {
    return (
      <FleetFrame fleetManager={fleetManager}>
        <div className="fleet-empty">Load failed: {summary.error}</div>
      </FleetFrame>
    );
  }

  return (
    <FleetFrame fleetManager={fleetManager} generatedAt={summary.generatedAt}>
      <div className="fleet-manage-bar">
        <div>
          <strong>Vehicle master</strong>
        </div>
        {canAddVehicle ? <button className="fleet-btn primary" onClick={() => setVehicleModal({ action: "add", canEdit: true })} type="button">Add vehicle</button> : null}
      </div>
      {fleetFlash?.error ? <div className="fleet-empty small error">{fleetFlash.error}</div> : null}
      {fleetFlash?.notice ? <div className="fleet-empty small success">{fleetFlash.notice}</div> : null}

      <div className="fleet-tabs">
        {visibleModes.map((item) => (
          <button className={`fleet-tab ${mode === item ? "active" : ""}`} key={item} onClick={() => changeMode(item)} type="button">
            {item}
          </button>
        ))}
      </div>

      {mode === "Action Center" ? (
        <div className="fleet-kpis">
          <Kpi icon={<Activity size={16} />} label="Vehicles" value={formatNumber(totals.vehicles)} hint="filtered fleet" />
          <Kpi icon={<Gauge size={16} />} label="KM" value={formatNumber(totals.km)} hint="GPS/manual" />
          <Kpi icon={<Fuel size={16} />} label="Litres" value={formatNumber(totals.litres)} hint="card litres" />
          <Kpi icon={<Fuel size={16} />} label="Fuel Amount" value={formatCurrency(totals.fuel)} hint="fuel spend" />
          <Kpi icon={<Gauge size={16} />} label="Mileage" value={mileage ? `${formatNumber(mileage)} km/L` : "-"} hint="available KM" />
          <Kpi icon={<TriangleAlert size={16} />} label="Cost/KM" value={costKm ? formatCurrency(costKm) : "-"} hint="fuel only" />
        </div>
      ) : null}

      <section className="fleet-panel">
        <div className="fleet-panel-head">
          <div className="fleet-panel-title">{mode}</div>
          <div className="fleet-panel-note">DropX owned fleet control tower</div>
        </div>
        {mode === "Action Center" ? <ActionCenter rows={mappedRows} /> : null}
        {mode === "Documents" ? <DateView canEdit={Boolean(tabPermissions.Documents?.canEdit)} documentTypes={documentTypes} rows={mappedRows} onManage={(action, row, documentType, documentIntent) => setVehicleModal({ action, vehicle: row, documentType, documentIntent, canEdit: Boolean(tabPermissions.Documents?.canEdit) })} /> : null}
        {mode === "Vehicles" ? <VehicleView canEdit={Boolean(tabPermissions.Vehicles?.canEdit)} rows={mappedRows} onManage={(action, row, documentType, documentIntent) => setVehicleModal({ action, vehicle: row, documentType, documentIntent, canEdit: Boolean(tabPermissions.Vehicles?.canEdit) })} /> : null}
        {mode === "Station View" ? <StationView rows={mappedRows} /> : null}
        {mode === "Tracking" ? (
          <TrackingView
            date={date}
            gpsRows={summary.gpsLive ?? []}
            loading={routeLoading}
            openTracking={openTracking}
            refreshFleet={refreshFleet}
            route={route}
            rows={liveTrackedRows.length ? liveTrackedRows : metrics}
            setDate={setDate}
            vehicle={vehicle}
          />
        ) : null}
        {mode === "Fuel Log" ? <FuelLog canUpload={Boolean(tabPermissions["Fuel Log"]?.canAdd || tabPermissions["Fuel Log"]?.canEdit)} error={summary.fuelError ?? undefined} rows={fuelRows} onUploaded={refreshFleet} /> : null}
        {mode === "Report" ? <FleetReports fuelReports={<FleetFuelReport rows={fuelRows} />} /> : null}
        {mode === "Live GPS" ? <LiveGps rows={summary.gpsLive ?? []} /> : null}
        {mode === "Maintenance" ? <Maintenance rows={summary.maintenance ?? []} /> : null}
      </section>
      {vehicleModal ? (
        <VehicleModal
          action={vehicleModal.action}
          locations={summary.locations ?? []}
          onClose={() => !savingVehicle && setVehicleModal(null)}
          onSubmit={submitVehicle}
          saving={savingVehicle}
          vehicle={vehicleModal.vehicle}
          documentType={vehicleModal.documentType}
          documentTypes={documentTypes}
          documentIntent={vehicleModal.documentIntent}
          canEdit={vehicleModal.canEdit ?? canEditFleet}
        />
      ) : null}
    </FleetFrame>
  );
}

function FleetFrame({
  children,
  fleetManager,
  generatedAt
}: {
  children: React.ReactNode;
  fleetManager?: FleetManager | null;
  generatedAt?: string;
}) {
  return (
    <main className="fleet-page">
      <div className="fleet-header">
        <div className="fleet-title-row">
          <div className="fleet-mark" />
          <div>
            <h1>DropX Fleet Dashboard</h1>
            <p>{generatedAt ? `Updated ${formatDashboardDateTime(generatedAt)}` : "Loading latest fleet data"}</p>
          </div>
        </div>
        {fleetManager ? (
          <div className="business-doc-manager-inline">
            <span>Fleet manager</span>
            <strong>{fleetManager.name}</strong>
            {fleetManager.email ? <small>{fleetManager.email}</small> : null}
          </div>
        ) : null}
      </div>
      {children}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="fleet-label">{label}</label>
      {children}
    </div>
  );
}

function MultiCheckFilter({
  allLabel,
  getLabel = (value) => value,
  label,
  onChange,
  selected,
  values
}: {
  allLabel: string;
  getLabel?: (value: string) => string;
  label: string;
  onChange: (values: string[]) => void;
  selected: string[];
  values: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const allSelected = selected.length === 0;
  const display = allSelected ? allLabel : `${selected.length} selected`;
  const visibleValues = values.filter((value) => `${value} ${getLabel(value)}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function toggleValue(value: string) {
    const next = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    onChange(next);
  }

  return (
    <div className="fleet-multi-filter" ref={ref}>
      <label className="fleet-label">{label}</label>
      <button className="fleet-filter-button" onClick={() => setOpen((current) => !current)} type="button">
        <span>{display}</span>
        <span aria-hidden="true">∨</span>
      </button>
      {open ? (
        <div className="fleet-filter-menu">
          <input
            className="fleet-filter-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${label.toLowerCase()}`}
            value={query}
          />
          <label>
            <input checked={allSelected} onChange={() => onChange([])} type="checkbox" />
            {allLabel}
          </label>
          {visibleValues.map((value) => (
            <label key={value}>
              <input checked={selected.includes(value)} onChange={() => toggleValue(value)} type="checkbox" />
              {getLabel(value)}
            </label>
          ))}
          {!visibleValues.length ? <div className="fleet-filter-empty">No matches</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Kpi({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return (
    <div className="fleet-kpi">
      <div className="fleet-kpi-label">{icon} {label}</div>
      <div className="fleet-kpi-value">{value}</div>
      <div className="fleet-kpi-hint">{hint}</div>
    </div>
  );
}

function Status({ value, type = "warn" }: { value: string; type?: "ok" | "warn" | "bad" }) {
  return <span className={`fleet-status ${type}`}>{value}</span>;
}

function ActionCenter({ rows }: { rows: FleetMetric[] }) {
  const [stations, setStations] = useState<string[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const issueOptions = ["Expired", "Due", "Insurance", "PUC", "Fitness", "Tax"];
  const filtered = rows.filter((row) => (
    (stations.length === 0 || stations.includes(row.station_code)) &&
    (issues.length === 0 || issues.some((issue) => row.alerts.some((alert) => alert.toLowerCase().includes(issue.toLowerCase()))))
  ));
  const vehicles = [...filtered].sort((a, b) => a.healthScore - b.healthScore || a.vehicle_no.localeCompare(b.vehicle_no));

  return (
    <div className="fleet-action-center">
      <div className="fleet-local-filters">
        <MultiCheckFilter allLabel="All locations" label="Location" onChange={setStations} selected={stations} values={uniqueValues(rows.map((row) => row.station_code))} />
        <MultiCheckFilter allLabel="All issues" label="Issue" onChange={setIssues} selected={issues} values={issueOptions} />
      </div>
      <div className="fleet-section-title">Vehicles</div>
      {vehicles.length ? (
        <div className="fleet-action-grid">
          {vehicles.map((row) => (
          <div className="fleet-card" key={row.vehicle_no}>
            <div className="fleet-card-top">
              <span className="fleet-vehicle-text">{row.vehicle_no}</span>
            </div>
            <div className="fleet-muted">{row.model} / {row.fuel_type} / {row.station_code}</div>
            <div className="fleet-status-row">
              {Array.from(new Set(row.alerts)).map((alert) => (
                <Status value={alert} type={alert.toLowerCase().includes("expired") ? "bad" : "warn"} key={alert} />
              ))}
            </div>
            <div className="fleet-metrics">
              <Mini label="KM" value={formatNumber(row.km)} />
              <Mini label="Fuel" value={formatCurrency(row.fuelAmount)} />
              <Mini label="Mileage" value={row.mileage ? formatNumber(row.mileage) : "-"} />
              <Mini label="Cost/KM" value={row.costPerKm ? formatCurrency(row.costPerKm) : "-"} />
            </div>
          </div>
          ))}
        </div>
      ) : <div className="fleet-empty">No vehicles for selected filters.</div>}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div>{label}<br /><b>{value}</b></div>;
}

type FleetDateRow = {
  vehicle: FleetMetric;
  document: string;
  documentType: FleetDocumentType;
  date: string;
  days: number;
};

function DateView({
  canEdit,
  documentTypes,
  rows,
  onManage
}: {
  canEdit: boolean;
  documentTypes: FleetDocumentDefinition[];
  rows: FleetMetric[];
  onManage: (action: FleetAction, vehicle: FleetMetric, documentType?: FleetDocumentType, documentIntent?: "view" | "change") => void;
}) {
  const [stations, setStations] = useState<string[]>([]);
  const [documents, setDocuments] = useState<string[]>([]);
  const [urgencies, setUrgencies] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const allDateRows = rows.flatMap((row) => {
    const documents = documentTypes.map((documentItem) => ({
      document: documentItem.label,
      documentType: documentItem.value,
      date: getDateViewDocumentDate(row, documentItem.value)
    }));

    return documents
      .filter((item) => isIsoDate(item.date) || item.documentType === "FLEET_REGISTRATION")
      .map((item) => ({
        vehicle: row,
        document: item.document,
        documentType: item.documentType,
        date: isIsoDate(item.date) ? item.date : "",
        days: isIsoDate(item.date) ? getDaysUntilExpiry(item.date) : null
      }));
  });
  const baseDateRows = allDateRows.filter((row) => (
    (!stations.length || stations.includes(row.vehicle.station_code)) &&
    (!documents.length || documents.includes(row.documentType)) &&
    (!search.trim() || row.vehicle.vehicle_no.toLowerCase().includes(search.trim().toLowerCase()) || row.vehicle.station_code.toLowerCase().includes(search.trim().toLowerCase()))
  ));
  const dateRows = baseDateRows.filter((row) => !urgencies.length || (row.days !== null && urgencies.includes(dateUrgencyBucket(row.days))))
    .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999) || a.vehicle.vehicle_no.localeCompare(b.vehicle.vehicle_no) || a.document.localeCompare(b.document));
  const totalPages = Math.max(1, Math.ceil(dateRows.length / 50));
  const pageRows = dateRows.slice((page - 1) * 50, page * 50);

  useEffect(() => {
    setPage(1);
  }, [stations, documents, urgencies, search]);

  const counts = {
    all: baseDateRows.length,
    active: baseDateRows.filter((row) => row.days !== null && row.days > 30).length,
    expired: baseDateRows.filter((row) => row.days !== null && row.days < 0).length,
    due7: baseDateRows.filter((row) => row.days !== null && row.days >= 0 && row.days <= 7).length,
    due15: baseDateRows.filter((row) => row.days !== null && row.days >= 8 && row.days <= 15).length,
    due30: baseDateRows.filter((row) => row.days !== null && row.days >= 16 && row.days <= 30).length
  };
  const documentFilterOptions = documentTypes.map((item) => item.value);
  const statusOptions = ["valid", "due30", "due15", "due7", "expired"];
  const documentLabelByType = new Map(documentTypes.map((item) => [item.value, item.label]));
  const statusLabels: Record<string, string> = {
    due15: "7-15 D",
    due30: "15-30 D",
    due7: "0-7 D",
    expired: "Expired",
    valid: "Valid"
  };

  function toggleUrgency(bucket: string) {
    setUrgencies((current) => current.length === 1 && current[0] === bucket ? [] : [bucket]);
  }

  return (
    <div className="fleet-date-view">
      <div className="fleet-local-filters">
        <Field label="Search">
          <input placeholder="Vehicle or location" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Field>
        <MultiCheckFilter allLabel="All locations" label="Location" onChange={setStations} selected={stations} values={uniqueValues(rows.map((row) => row.station_code))} />
        <MultiCheckFilter allLabel="All documents" getLabel={(value) => documentLabelByType.get(value) ?? documentLabel(value)} label="Document" onChange={setDocuments} selected={documents} values={documentFilterOptions} />
        <MultiCheckFilter allLabel="All expiry" getLabel={(value) => statusLabels[value] ?? value} label="Expiry" onChange={setUrgencies} selected={urgencies} values={statusOptions} />
      </div>
      <div className="fleet-date-summary">
        <DateSummary active={!urgencies.length} label="All" onClick={() => setUrgencies([])} value={counts.all} tone="all" />
        <DateSummary active={urgencies.includes("valid")} label="Active" onClick={() => toggleUrgency("valid")} value={counts.active} tone="active" />
        <DateSummary active={urgencies.includes("due30")} label="Expires in 15-30 D" onClick={() => toggleUrgency("due30")} value={counts.due30} tone="due-yellow" />
        <DateSummary active={urgencies.includes("due15")} label="Expires in 7-15 D" onClick={() => toggleUrgency("due15")} value={counts.due15} tone="due-pink" />
        <DateSummary active={urgencies.includes("due7")} label="Expires in 0-7 D" onClick={() => toggleUrgency("due7")} value={counts.due7} tone="due-orange" />
        <DateSummary active={urgencies.includes("expired")} label="Expired" onClick={() => toggleUrgency("expired")} value={counts.expired} tone="expired" />
      </div>
      <DataTable
        headers={["Vehicle", "Location", "RC Location", "Document", "Expiry Date", "Status", "Days", "File", ...(canEdit ? ["Action"] : [])]}
        rows={pageRows.map((row) => [
          <span className="fleet-vehicle-text" key={row.vehicle.vehicle_no}>{row.vehicle.vehicle_no}</span>,
          row.vehicle.station_code,
          row.vehicle.rc_location || "-",
          row.document,
          <ExpiryDateTag value={row.date || undefined} key="date" />,
          row.days === null ? "-" : <ExpiryStatusTag days={row.days} key="status" />,
          row.days === null ? "-" : formatDaysLabel(row.days),
          <FleetDateFileActions documentType={row.documentType} key="file" row={row.vehicle} />,
          ...(canEdit ? [<button className="fleet-btn ghost compact" key="manage" onClick={() => onManage("renewal", row.vehicle, row.documentType, "change")} type="button">Manage</button>] : [])
        ])}
      />
      {dateRows.length > 50 ? (
        <div className="fleet-pagination">
          <span>Page {page} of {totalPages}</span>
          <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">Previous</button>
          <button disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} type="button">Next</button>
        </div>
      ) : null}
      <div className="fleet-date-mobile-list">
        {pageRows.length ? pageRows.map((row) => (
          <article className="fleet-date-mobile-card" key={`${row.vehicle.vehicle_no}-${row.document}`}>
            <div className="fleet-date-mobile-head">
              <div>
                <strong>{row.vehicle.vehicle_no}</strong>
                <span>{row.vehicle.station_code} · RC {row.vehicle.rc_location || "-"}</span>
              </div>
              {canEdit ? <button className="fleet-btn ghost compact" onClick={() => onManage("renewal", row.vehicle, row.documentType, "change")} type="button">Manage</button> : null}
            </div>
            <div className="fleet-date-mobile-doc">
              <span>{row.document}</span>
              {row.days === null ? <span>-</span> : <ExpiryStatusTag days={row.days} />}
            </div>
            <dl className="fleet-date-mobile-meta">
              <div>
                <dt>Expiry</dt>
                <dd><ExpiryDateTag value={row.date || undefined} /></dd>
              </div>
              <div>
                <dt>Days</dt>
                <dd>{row.days === null ? "-" : formatDaysLabel(row.days)}</dd>
              </div>
            </dl>
            <FleetDateFileActions documentType={row.documentType} row={row.vehicle} />
          </article>
        )) : <div className="fleet-empty">No data for selected filters.</div>}
      </div>
    </div>
  );
}

function FleetDateFileActions({
  row,
  documentType
}: {
  row: FleetMetric;
  documentType: FleetDocumentType;
}) {
  const [loading, setLoading] = useState<"view" | "download" | null>(null);

  async function getDocumentUrl() {
    const response = await fetch(`/api/fleet/documents?vehicle_no=${encodeURIComponent(row.vehicle_no)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to load document.");
    const document = (payload.documents ?? []).find((item: FleetDocumentRecord) => item.document_type === documentType);
    if (!document?.signed_url) throw new Error("Document file is not uploaded.");
    return {
      fileName: document.file_name || `${row.vehicle_no}-${documentLabel(documentType)}`,
      url: document.signed_url as string,
      downloadUrl: document.download_url || `${document.signed_url}&download=1`
    };
  }

  async function openDocument() {
    try {
      setLoading("view");
      const document = await getDocumentUrl();
      window.open(document.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to open document.");
    } finally {
      setLoading(null);
    }
  }

  async function downloadDocument() {
    try {
      setLoading("download");
      const document = await getDocumentUrl();
      const response = await fetch(document.downloadUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = document.fileName;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to download document.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="fleet-file-actions">
      <button aria-label={`Open ${documentLabel(documentType)} for ${row.vehicle_no}`} className={`icon-button ${loading === "view" ? "loading" : ""}`} disabled={Boolean(loading)} onClick={openDocument} title="Open" type="button">
        <Eye size={16} />
      </button>
      <button aria-label={`Download ${documentLabel(documentType)} for ${row.vehicle_no}`} className={`icon-button ${loading === "download" ? "loading" : ""}`} disabled={Boolean(loading)} onClick={downloadDocument} title="Download" type="button">
        <Download size={16} />
      </button>
    </div>
  );
}

function DateSummary({ active, label, onClick, value, tone }: { active?: boolean; label: string; onClick?: () => void; value: number; tone: string }) {
  return (
    <button className={`fleet-date-summary-card ${tone} ${active ? "selected" : ""}`} onClick={onClick} type="button">
      <span>{label}</span>
      <b>{value}</b>
    </button>
  );
}

function VehicleView({
  canEdit,
  rows,
  onManage
}: {
  canEdit: boolean;
  rows: FleetMetric[];
  onManage: (action: FleetAction, vehicle: FleetMetric, documentType?: FleetDocumentType, documentIntent?: "view" | "change") => void;
}) {
  const [search, setSearch] = useState("");
  const [station, setStation] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const filtered = rows.filter((row) => (
    (!search.trim() || row.vehicle_no.toLowerCase().includes(search.trim().toLowerCase()) || row.model.toLowerCase().includes(search.trim().toLowerCase())) &&
    (station === "ALL" || row.station_code === station) &&
    (status === "ALL" || (row.status || "active").toLowerCase() === status)
  ));
  const totalPages = Math.max(1, Math.ceil(filtered.length / 50));
  const pageRows = filtered.slice((page - 1) * 50, page * 50);

  useEffect(() => {
    setPage(1);
  }, [search, station, status]);

  return (
    <>
      <div className="fleet-local-filters">
        <Field label="Search">
          <input placeholder="Vehicle or model" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Field>
        <Field label="Location">
          <select value={station} onChange={(event) => setStation(event.target.value)}>
            <option value="ALL">All locations</option>
            {uniqueValues(rows.map((row) => row.station_code)).map((item) => <option key={item}>{item}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="ALL">All statuses</option>
            {uniqueValues(rows.map((row) => (row.status || "active").toLowerCase())).map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
          </select>
        </Field>
      </div>
      <DataTable
        headers={["Vehicle", "Model", "Fuel", "Station", "RC", "Insurance", "PUC", "Fitness", "Tax", "Alerts", ...(canEdit ? ["Action"] : [])]}
        rows={pageRows.map((row) => [
          <span className="fleet-vehicle-text" key={row.vehicle_no}>{row.vehicle_no}</span>,
          row.model,
          row.fuel_type,
          row.station_code,
          row.rc_location || "-",
          <ExpiryDateTag value={row.insurance_expiry} key="insurance" />,
          <ExpiryDateTag value={row.puc_expiry} key="puc" />,
          <ExpiryDateTag value={row.fitness_expiry} key="fitness" />,
          <ExpiryDateTag value={row.tax_expiry} key="tax" />,
          row.alerts.length ? Array.from(new Set(row.alerts)).join(", ") : <Status value="OK" type="ok" key="ok" />,
          ...(canEdit ? [<VehicleActionMenu canEdit={canEdit} key="actions" row={row} onManage={onManage} />] : [])
        ])}
      />
      {filtered.length > 50 ? (
        <div className="fleet-pagination">
          <span>Page {page} of {totalPages}</span>
          <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">Previous</button>
          <button disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} type="button">Next</button>
        </div>
      ) : null}
    </>
  );
}

function ExpiryDateTag({ value }: { value?: string }) {
  const formatted = formatDateValue(value);
  if (formatted === "-") return <span>-</span>;
  const urgency = getExpiryUrgency(value);
  return <span className={`fleet-date-tag ${urgency}`}>{formatted}</span>;
}

function ExpiryStatusTag({ days }: { days: number }) {
  const status = formatExpiryStatusLabel(days);
  const urgency = days < 0 ? "expired" : days < 7 ? "due-orange" : days < 15 ? "due-pink" : days < 30 ? "due-yellow" : "normal";
  if (!status) return <span>-</span>;
  return <span className={`fleet-date-tag ${urgency}`}>{status}</span>;
}

function VehicleActionMenu({
  canEdit,
  row,
  onManage
}: {
  canEdit: boolean;
  row: FleetMetric;
  onManage: (action: FleetAction, vehicle: FleetMetric, documentType?: FleetDocumentType, documentIntent?: "view" | "change") => void;
}) {
  const [open, setOpen] = useState(false);
  const actions: { label: string; action: FleetAction; danger?: boolean; documentIntent?: "view" | "change" }[] = [
    ...(canEdit ? [
      { label: "Move", action: "transfer" as const },
      { label: "Edit", action: "edit" as const },
      { label: "Sale", action: "sale" as const },
      { label: "Dispose", action: "dispose" as const, danger: true }
    ] : [])
  ];

  function select(action: FleetAction, documentIntent?: "view" | "change") {
    setOpen(false);
    onManage(action, row, undefined, documentIntent);
  }

  return (
    <div className="fleet-action-menu">
      <button aria-expanded={open} aria-label={`Open actions for ${row.vehicle_no}`} className="fleet-action-trigger" onClick={() => setOpen((current) => !current)} type="button">
        <MoreVertical size={16} />
      </button>
      {open ? (
        <div className="fleet-action-dropdown">
          {actions.map((item) => (
            <button className={item.danger ? "danger" : ""} key={`${item.action}-${item.label}`} onClick={() => select(item.action, item.documentIntent)} type="button">
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function VehicleModal({
  action,
  vehicle,
  documentType,
  documentTypes,
  documentIntent,
  canEdit,
  saving,
  locations,
  onClose,
  onSubmit
}: {
  action: FleetAction;
  vehicle?: FleetMetric;
  documentType?: FleetDocumentType;
  documentTypes: FleetDocumentDefinition[];
  documentIntent?: "view" | "change";
  canEdit: boolean;
  locations: FleetLocation[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (action: FleetAction, form: FleetVehicleForm, documents?: Partial<Record<FleetDocumentType, File | null>>, documentExpiries?: Partial<Record<FleetDocumentType, string>>) => void;
}) {
  const [form, setForm] = useState<FleetVehicleForm>(() => ({
    vehicle_no: vehicle?.vehicle_no ?? "",
    station_code: vehicle?.station_code ?? "",
    rc_location: vehicle?.rc_location ?? "",
    model: vehicle?.model ?? "",
    fuel_type: vehicle?.fuel_type ?? "",
    registration_expiry: vehicle?.registration_expiry ?? "",
    insurance_expiry: vehicle?.insurance_expiry ?? "",
    puc_expiry: vehicle?.puc_expiry ?? "",
    fitness_expiry: vehicle?.fitness_expiry ?? "",
    tax_expiry: vehicle?.tax_expiry ?? "",
    status: vehicle?.status ?? "active",
    transfer_date: vehicle?.transfer_date ?? (action === "transfer" ? todayIsoDate() : ""),
    sale_date: vehicle?.sale_date ?? (action === "sale" ? todayIsoDate() : ""),
    dispose_date: vehicle?.dispose_date ?? (action === "dispose" ? todayIsoDate() : "")
  }));
  const [documentFilter, setDocumentFilter] = useState<FleetDocumentType | "all">(() => documentType ?? "all");
  const [documents, setDocuments] = useState<FleetDocumentRecord[]>([]);
  const [documentFiles, setDocumentFiles] = useState<Partial<Record<FleetDocumentType, File | null>>>({});
  const [documentExpiries, setDocumentExpiries] = useState<Partial<Record<FleetDocumentType, string>>>(() =>
    Object.fromEntries(documentTypes.map((item) => {
      const field = documentExpiryField(item.value);
      return [item.value, field ? vehicle?.[field] ?? "" : ""];
    }))
  );
  const [registrationAsFitness, setRegistrationAsFitness] = useState(() => (vehicle?.registration_expiry ?? "") === "As per Fitness");
  const [manualRcLocation, setManualRcLocation] = useState(() => {
    const initial = vehicle?.rc_location ?? "";
    if (!initial || initial === "Digital" || initial === "RTO Agent") return "";
    return locations.some((location) => location.code === initial) ? "" : initial;
  });
  const title = action === "add" ? "Add vehicle" : action === "edit" ? "Edit vehicle" : action === "transfer" ? "Move vehicle" : documentIntent === "view" || documentIntent === "change" ? "Vehicle document" : action === "renewal" ? "Renewal update" : action === "sale" ? "Sale vehicle" : "Dispose vehicle";
  const isStatusAction = action === "sale" || action === "dispose";
  const isDocumentCard = action === "renewal" && Boolean(documentIntent);
  const lockDocumentCard = isDocumentCard && Boolean(documentType);
  const showMaster = action === "add" || action === "edit";
  const showTransfer = action === "add" || action === "edit" || action === "transfer";
  const showRenewal = action === "add" || (action === "renewal" && !isDocumentCard);
  const locationOptions = locationSelectOptions(locations, form.station_code);
  const rcLocationOptions = [
    { value: "Digital", label: "Digital", helper: "Digital copy available" },
    { value: "RTO Agent", label: "RTO Agent", helper: "Physical RC with agent" },
    { value: "__manual__", label: "Manual entry", helper: "RC kept outside listed locations" },
    ...locationSelectOptions(locations, form.rc_location)
  ];
  const rcIsManual = form.rc_location === "__manual__";

  useEffect(() => {
    if (!isDocumentCard || !form.vehicle_no) return;
    let active = true;
    fetch(`/api/fleet/documents?vehicle_no=${encodeURIComponent(form.vehicle_no)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (active) setDocuments(Array.isArray(payload.documents) ? payload.documents : []);
      })
      .catch(() => {
        if (active) setDocuments([]);
      });
    return () => {
      active = false;
    };
  }, [form.vehicle_no, isDocumentCard]);

  function update(field: keyof FleetVehicleForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(action, {
      ...form,
      registration_expiry: registrationAsFitness ? "" : form.registration_expiry,
      rc_location: rcIsManual ? manualRcLocation : form.rc_location
    }, isDocumentCard || showRenewal ? documentFiles : undefined, isDocumentCard || showRenewal ? documentExpiries : undefined);
  }

  function updateRenewalDocument(documentType: FleetDocumentType, value: string) {
    const field = documentExpiryField(documentType);
    setDocumentExpiries((current) => ({ ...current, [documentType]: value }));
    if (field) update(field, value);
  }

  function updateRenewalFile(documentType: FleetDocumentType, file: File | null) {
    setDocumentFiles((current) => ({ ...current, [documentType]: file }));
  }

  function toggleRegistrationAsFitness(checked: boolean) {
    setRegistrationAsFitness(checked);
    if (checked) updateRenewalDocument("FLEET_REGISTRATION", "");
  }

  return (
    <div className="modal-backdrop confirmation-backdrop">
      <section aria-modal="true" className="modal-panel fleet-vehicle-modal" role="dialog">
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            <p className="subtle">{vehicle?.vehicle_no ?? "Create a new fleet vehicle record."}</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button">x</button>
        </div>
        <form onSubmit={submit}>
          {isStatusAction ? (
            <div className="confirmation-body">
              <p>
                Mark vehicle <strong>{form.vehicle_no}</strong> as {action === "sale" ? "sold" : "disposed"}?
                The vehicle record will remain in Fleet history.
              </p>
              <Field label={action === "sale" ? "Sale date" : "Dispose date"}>
                <input
                  className="field"
                  onChange={(event) => update(action === "sale" ? "sale_date" : "dispose_date", event.target.value)}
                  required
                  type="date"
                  value={dateInputValue(action === "sale" ? form.sale_date : form.dispose_date)}
                />
              </Field>
            </div>
          ) : isDocumentCard ? (
            <DocumentCardPanel
              canEdit={canEdit}
              filter={lockDocumentCard && documentType ? documentType : documentFilter}
              form={form}
              documents={documents}
              files={documentFiles}
              documentTypes={documentTypes}
              expiries={documentExpiries}
              onExpiryChange={(type, value) => {
                const field = documentExpiryField(type);
                setDocumentExpiries((current) => ({ ...current, [type]: value }));
                if (field) update(field, value);
              }}
              onFileChange={(type, file) => setDocumentFiles((current) => ({ ...current, [type]: file }))}
              onFilterChange={setDocumentFilter}
              showFilter={!lockDocumentCard}
              vehicle={form.vehicle_no}
            />
          ) : (
            <div className={showRenewal && action === "renewal" ? "fleet-renewal-grid" : "fleet-vehicle-form"}>
              {action !== "renewal" ? (
                <label>Vehicle no
                  <input className="field" disabled={action !== "add"} onChange={(event) => update("vehicle_no", event.target.value.toUpperCase())} required value={form.vehicle_no} />
                </label>
              ) : null}
              {showTransfer ? (
                <>
                  <label>Location
                    <SearchableSelect
                      name="fleet_station_code"
                      onValueChange={(value) => update("station_code", value)}
                      options={locationOptions}
                      placeholder="Search location"
                      required
                      value={form.station_code}
                    />
                  </label>
                  {action === "transfer" ? (
                    <label>Move date
                      <input className="field" onChange={(event) => update("transfer_date", event.target.value)} required type="date" value={dateInputValue(form.transfer_date)} />
                    </label>
                  ) : null}
                </>
              ) : null}
              {showMaster ? (
                <>
                  <label>RC location
                    <SearchableSelect
                      name="fleet_rc_location"
                      onValueChange={(value) => update("rc_location", value)}
                      options={rcLocationOptions}
                      placeholder="Search RC location"
                      value={form.rc_location}
                    />
                  </label>
                  {rcIsManual ? (
                    <label>Manual RC location
                      <input className="field" onChange={(event) => setManualRcLocation(event.target.value)} placeholder="Enter manual RC location" required value={manualRcLocation} />
                    </label>
                  ) : null}
                  <label>Model
                    <input className="field" onChange={(event) => update("model", event.target.value)} required value={form.model} />
                  </label>
                  <label>Fuel
                    <select className="field" onChange={(event) => update("fuel_type", event.target.value)} required value={form.fuel_type}>
                      <option value="">Select fuel</option>
                      <option>Diesel</option>
                      <option>Petrol</option>
                      <option>CNG</option>
                      <option>EV</option>
                    </select>
                  </label>
                  <label>Status
                    <select className="field" onChange={(event) => update("status", event.target.value)} required value={form.status}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="repair">Repair</option>
                      <option value="sold">Sold</option>
                      <option value="returned">Returned</option>
                    </select>
                  </label>
                </>
              ) : null}
              {showRenewal ? (
                <div className={action === "renewal" ? "fleet-renewal-card-grid" : "fleet-renewal-card-grid embedded"}>
                  <div className="fleet-renewal-card">
                    <div className="fleet-renewal-card-head">
                      <span>Registration expiry</span>
                      <label className="fleet-renewal-check">
                        <input checked={registrationAsFitness} onChange={(event) => toggleRegistrationAsFitness(event.target.checked)} type="checkbox" />
                        As per Fitness
                      </label>
                    </div>
                    <input
                      className="field"
                      disabled={registrationAsFitness}
                      onChange={(event) => updateRenewalDocument("FLEET_REGISTRATION", event.target.value)}
                      type="date"
                      value={registrationAsFitness ? "" : dateInputValue(form.registration_expiry)}
                    />
                    <input className="field compact-file" onChange={(event) => updateRenewalFile("FLEET_REGISTRATION", event.target.files?.[0] ?? null)} type="file" />
                  </div>
                  <div className="fleet-renewal-card">
                    <span>Vehicle Insurance expiry</span>
                    <input className="field" onChange={(event) => updateRenewalDocument("FLEET_INSURANCE", event.target.value)} type="date" value={dateInputValue(form.insurance_expiry)} />
                    <input className="field compact-file" onChange={(event) => updateRenewalFile("FLEET_INSURANCE", event.target.files?.[0] ?? null)} type="file" />
                  </div>
                  <div className="fleet-renewal-card">
                    <span>PUC expiry</span>
                    <input className="field" onChange={(event) => updateRenewalDocument("FLEET_PUC", event.target.value)} type="date" value={dateInputValue(form.puc_expiry)} />
                    <input className="field compact-file" onChange={(event) => updateRenewalFile("FLEET_PUC", event.target.files?.[0] ?? null)} type="file" />
                  </div>
                  <div className="fleet-renewal-card">
                    <span>Fitness expiry</span>
                    <input className="field" onChange={(event) => updateRenewalDocument("FLEET_FITNESS", event.target.value)} type="date" value={dateInputValue(form.fitness_expiry)} />
                    <input className="field compact-file" onChange={(event) => updateRenewalFile("FLEET_FITNESS", event.target.files?.[0] ?? null)} type="file" />
                  </div>
                  <div className="fleet-renewal-card">
                    <span>Tax expiry</span>
                    <input className="field" onChange={(event) => updateRenewalDocument("FLEET_TAX", event.target.value)} type="date" value={dateInputValue(form.tax_expiry)} />
                    <input className="field compact-file" onChange={(event) => updateRenewalFile("FLEET_TAX", event.target.files?.[0] ?? null)} type="file" />
                  </div>
                </div>
              ) : null}
            </div>
          )}
          <div className="form-actions modal-actions">
            <button className="button secondary" disabled={saving} onClick={onClose} type="button">{isDocumentCard && !canEdit ? "Close" : "Cancel"}</button>
            {isDocumentCard && !canEdit ? null : (
              <button className={isStatusAction ? "button danger" : "button"} disabled={saving} type="submit">
                {saving ? "Saving" : isStatusAction ? "Confirm" : isDocumentCard ? "Save document" : "Save"}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

function DocumentCardPanel({
  canEdit,
  filter,
  form,
  documents,
  documentTypes,
  expiries,
  files,
  vehicle,
  onFileChange,
  onExpiryChange,
  onFilterChange,
  showFilter = true
}: {
  canEdit: boolean;
  filter: FleetDocumentType | "all";
  form: FleetVehicleForm;
  documents: FleetDocumentRecord[];
  documentTypes: FleetDocumentDefinition[];
  expiries: Partial<Record<FleetDocumentType, string>>;
  files: Partial<Record<FleetDocumentType, File | null>>;
  vehicle: string;
  onFileChange: (type: FleetDocumentType, file: File | null) => void;
  onExpiryChange: (type: FleetDocumentType, value: string) => void;
  onFilterChange: (value: FleetDocumentType | "all") => void;
  showFilter?: boolean;
}) {
  const visibleDocuments = filter === "all" ? documentTypes : documentTypes.filter((item) => item.value === filter);
  const documentMap = new Map(documents.map((item) => [item.document_type, item]));

  return (
    <div className="fleet-document-panel">
      {showFilter ? (
        <Field label="Filter document">
          <select value={filter} onChange={(event) => onFilterChange(event.target.value as FleetDocumentType | "all")}>
            <option value="all">All documents</option>
            {documentTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </Field>
      ) : null}
      <div className="fleet-document-list">
        {visibleDocuments.map((documentItem) => (
          <div className="fleet-document-card-grid" key={documentItem.value}>
            <div className="fleet-document-card">
              <div className="fleet-document-card-title">{documentItem.label}</div>
              <DocumentPreview document={documentMap.get(documentItem.value)} documentLabel={documentItem.label} vehicle={vehicle} />
            </div>
            {canEdit ? (
              <div className="fleet-document-card">
                <div className="fleet-document-card-title">Upload new</div>
                <div className="fleet-document-upload">
                  <Field label="New expiry date">
                    <input
                      type="date"
                      value={dateInputValue(expiries[documentItem.value] ?? getDocumentExpiryValue(form, documentItem.value))}
                      disabled={documentItem.requires_expiry === false}
                      onChange={(event) => onExpiryChange(documentItem.value, event.target.value)}
                    />
                  </Field>
                  <Field label="Document file">
                    <input type="file" onChange={(event) => onFileChange(documentItem.value, event.target.files?.[0] ?? null)} />
                  </Field>
                  {files[documentItem.value] ? <span className="fleet-document-selected">{files[documentItem.value]?.name}</span> : null}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {canEdit ? <div className="fleet-empty small">
        Existing document will be scheduled for deletion after 30 days when document storage is connected.
      </div> : null}
    </div>
  );
}

function DocumentPreview({
  document,
  documentLabel,
  vehicle
}: {
  document?: FleetDocumentRecord;
  documentLabel: string;
  vehicle: string;
}) {
  if (!document) {
    return (
      <div className="fleet-document-preview">
        <strong>{vehicle}</strong>
        <span>{documentLabel} document is not uploaded in Fleet yet.</span>
      </div>
    );
  }
  const isImage = Boolean(document.content_type?.startsWith("image/"));
  const isPdf = document.content_type === "application/pdf" || document.file_name.toLowerCase().endsWith(".pdf");
  const PreviewTag = document.signed_url ? "a" : "div";
  return (
    <PreviewTag className="fleet-document-preview has-document clickable" href={document.signed_url ?? undefined} rel="noreferrer" target={document.signed_url ? "_blank" : undefined}>
      {isImage && document.signed_url ? <img alt={`${documentLabel} preview`} src={document.signed_url} /> : null}
      {isPdf && document.signed_url ? <iframe className="fleet-document-pdf-preview" src={`${document.signed_url}#toolbar=0&navpanes=0`} title={`${documentLabel} preview`} /> : null}
      {!isImage && !isPdf ? <div className="fleet-document-file-icon">DOC</div> : null}
      <strong>{document.file_name}</strong>
      <span>{document.expiry_date ? `Expiry: ${formatDateValue(document.expiry_date)}` : "Expiry not set"}</span>
      <span>{document.uploaded_at ? `Uploaded: ${formatDateTime(document.uploaded_at)}` : ""}</span>
      {document.signed_url ? <span className="fleet-document-link-text">Open document</span> : null}
    </PreviewTag>
  );
}

function ModelView({ rows }: { rows: FleetMetric[] }) {
  const [fuel, setFuel] = useState("ALL");
  const filtered = rows.filter((row) => fuel === "ALL" || row.fuel_type === fuel);

  return (
    <>
      <div className="fleet-local-filters compact">
        <Field label="Fuel">
          <select value={fuel} onChange={(event) => setFuel(event.target.value)}>
            <option value="ALL">All fuel</option>
            {uniqueValues(rows.map((row) => row.fuel_type)).map((item) => <option key={item}>{item}</option>)}
          </select>
        </Field>
      </div>
      <DataTable
        headers={["Model/Fuel", "Vehicles", "KM", "Litres", "Fuel", "Mileage", "Cost/KM"]}
        rows={groupRows(filtered, (row) => `${row.model} / ${row.fuel_type}`).map((row) => [
          row.key,
          row.count,
          formatNumber(row.km),
          formatNumber(row.litres),
          formatCurrency(row.fuelAmount),
          row.litres ? formatNumber(row.km / row.litres) : "-",
          row.km ? formatCurrency(row.fuelAmount / row.km) : "-"
        ])}
      />
    </>
  );
}

function StationView({ rows }: { rows: FleetMetric[] }) {
  const [search, setSearch] = useState("");
  const filtered = rows.filter((row) => !search.trim() || row.station_code.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      <div className="fleet-local-filters compact">
        <Field label="Search">
          <input placeholder="Location code" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Field>
      </div>
      <DataTable
        headers={["Station", "Vehicles", "KM", "Litres", "Fuel", "Mileage", "Cost/KM"]}
        rows={groupRows(filtered, (row) => row.station_code).map((row) => [
          row.key,
          row.count,
          formatNumber(row.km),
          formatNumber(row.litres),
          formatCurrency(row.fuelAmount),
          row.litres ? formatNumber(row.km / row.litres) : "-",
          row.km ? formatCurrency(row.fuelAmount / row.km) : "-"
        ])}
      />
    </>
  );
}

function FuelLog({
  canUpload,
  error,
  onUploaded,
  rows
}: {
  canUpload: boolean;
  error?: string;
  onUploaded: () => Promise<void>;
  rows: FuelRow[];
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [provider, setProvider] = useState<FuelProvider>("IOC");
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [vehicles, setVehicles] = useState<string[]>([]);
  const [stations, setStations] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [quickPeriod, setQuickPeriod] = useState("CUSTOM");
  const [page, setPage] = useState(1);
  const vehicleOptions = uniqueValues(rows.map((row) => row.vehicle_no));
  const stationOptions = uniqueValues(rows.map((row) => row.station_code));
  const sourceOptions = uniqueValues(rows.map((row) => row.source));
  const filtered = rows.filter((row) => (
    (vehicles.length === 0 || vehicles.includes(row.vehicle_no)) &&
    (stations.length === 0 || stations.includes(row.station_code)) &&
    (sources.length === 0 || sources.includes(row.source)) &&
    (!fromDate || (row.transaction_at || "").slice(0, 10) >= fromDate) &&
    (!toDate || (row.transaction_at || "").slice(0, 10) <= toDate)
  ));
  const totalPages = Math.max(1, Math.ceil(filtered.length / 50));
  const pageRows = filtered.slice((page - 1) * 50, page * 50);

  useEffect(() => {
    setPage(1);
  }, [vehicles, stations, sources, fromDate, toDate]);

  async function uploadFuelFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setUploadMessage({ type: "error", text: "Select the fuel card file to upload." });
      return;
    }

    setUploading(true);
    setUploadMessage(null);
    try {
      const payload = new FormData();
      payload.append("provider", provider);
      payload.append("file", file);
      const response = await fetch("/api/fleet/fuel-upload", { method: "POST", body: payload });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Fuel upload failed.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await onUploaded();
      setUploadMessage({ type: "success", text: result.message || "Fuel transactions uploaded." });
    } catch (error) {
      setUploadMessage({ type: "error", text: error instanceof Error ? error.message : "Fuel upload failed." });
    } finally {
      setUploading(false);
    }
  }

  function applyQuickPeriod(value: string) {
    setQuickPeriod(value);
    const today = new Date();
    if (value === "ALL") {
      setFromDate("");
      setToDate("");
      return;
    }
    if (value === "TODAY") {
      const iso = toLocalIsoDate(today);
      setFromDate(iso);
      setToDate(iso);
      return;
    }
    if (value === "YESTERDAY") {
      const date = new Date(today);
      date.setDate(date.getDate() - 1);
      const iso = toLocalIsoDate(date);
      setFromDate(iso);
      setToDate(iso);
      return;
    }
    if (value === "CURRENT_MONTH") {
      setFromDate(toLocalIsoDate(new Date(today.getFullYear(), today.getMonth(), 1)));
      setToDate(toLocalIsoDate(today));
      return;
    }
    if (value === "LAST_MONTH") {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      setFromDate(toLocalIsoDate(start));
      setToDate(toLocalIsoDate(end));
    }
  }

  return (
    <>
      {canUpload ? (
        <form className="fleet-upload-card" onSubmit={uploadFuelFile}>
          <div>
            <strong>Daily fleet card upload</strong>
            <span>Choose provider and upload the matching IOC CSV or BPCL Excel report. Duplicate transaction IDs are ignored.</span>
          </div>
          <Field label="Fuel provider">
            <select value={provider} onChange={(event) => setProvider(event.target.value as FuelProvider)}>
              <option value="IOC">IOC</option>
              <option value="BPCL">BPCL</option>
            </select>
          </Field>
          <Field label="Transaction file">
            <input accept=".csv,.xlsx,.xls" ref={fileInputRef} type="file" />
          </Field>
          <button className="fleet-btn primary" disabled={uploading} type="submit">{uploading ? "Uploading..." : "Upload"}</button>
          {uploadMessage ? <p className={`fleet-upload-message ${uploadMessage.type}`}>{uploadMessage.text}</p> : null}
        </form>
      ) : null}
      {error ? <div className="fleet-upload-message error">Fuel report could not load: {error}</div> : null}
      <div className="fleet-upload-count">
        {rows.length} fuel rows loaded. {filtered.length} matching current filters.
      </div>
      <div className="fleet-local-filters">
        <Field label="Period">
          <select value={quickPeriod} onChange={(event) => applyQuickPeriod(event.target.value)}>
            <option value="CUSTOM">Custom</option>
            <option value="TODAY">Today</option>
            <option value="YESTERDAY">Yesterday</option>
            <option value="CURRENT_MONTH">Current month</option>
            <option value="LAST_MONTH">Last month</option>
            <option value="ALL">All dates</option>
          </select>
        </Field>
        <Field label="From date">
          <input type="date" value={fromDate} onChange={(event) => { setQuickPeriod("CUSTOM"); setFromDate(event.target.value); }} />
        </Field>
        <Field label="To date">
          <input type="date" value={toDate} onChange={(event) => { setQuickPeriod("CUSTOM"); setToDate(event.target.value); }} />
        </Field>
        <MultiCheckFilter allLabel="All vehicles" label="Vehicle" onChange={setVehicles} selected={vehicles} values={vehicleOptions} />
        <MultiCheckFilter allLabel="All locations" label="Location" onChange={setStations} selected={stations} values={stationOptions} />
        <MultiCheckFilter allLabel="All sources" label="Fuel source" onChange={setSources} selected={sources} values={sourceOptions} />
      </div>
      <DataTable
        headers={["Date", "Vehicle", "Station", "Source", "Pump", "Litres", "Amount"]}
        rows={pageRows.map((row) => [
          row.transaction_at ? formatDateValue(row.transaction_at.slice(0, 10)) : "-",
          row.vehicle_no,
          row.station_code,
          row.source,
          row.pump_name || "-",
          formatNumber(row.quantity),
          formatCurrency(row.amount)
        ])}
        numericFrom={null}
      />
      {filtered.length > 50 ? (
        <div className="fleet-pagination">
          <span>Page {page} of {totalPages}</span>
          <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">Previous</button>
          <button disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} type="button">Next</button>
        </div>
      ) : null}
    </>
  );
}

function FleetFuelReport({ rows }: { rows: FuelRow[] }) {
  const [reportType, setReportType] = useState<FuelReportType>("transactions");
  const [vehicles, setVehicles] = useState<string[]>([]);
  const [stations, setStations] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [fromDate, setFromDate] = useState(() => {
    const today = new Date();
    return toLocalIsoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  });
  const [toDate, setToDate] = useState(() => toLocalIsoDate(new Date()));
  const [quickPeriod, setQuickPeriod] = useState("CURRENT_MONTH");
  const [showResults, setShowResults] = useState(false);
  const [page, setPage] = useState(1);
  const vehicleOptions = uniqueValues(rows.map((row) => row.vehicle_no));
  const stationOptions = uniqueValues(rows.map((row) => row.station_code));
  const sourceOptions = uniqueValues(rows.map((row) => row.source));
  const filtered = rows.filter((row) => (
    (vehicles.length === 0 || vehicles.includes(row.vehicle_no)) &&
    (stations.length === 0 || stations.includes(row.station_code)) &&
    (sources.length === 0 || sources.includes(row.source)) &&
    (!fromDate || (row.transaction_at || "").slice(0, 10) >= fromDate) &&
    (!toDate || (row.transaction_at || "").slice(0, 10) <= toDate)
  ));
  const rowsForReport = buildFuelReportRows(filtered, reportType);
  const reportHeaders = rowsForReport[0]?.map(String) ?? [];
  const reportDataRows = rowsForReport.slice(1);
  const totalPages = Math.max(1, Math.ceil(reportDataRows.length / 50));
  const pageRows = reportDataRows.slice((page - 1) * 50, page * 50);

  useEffect(() => {
    setShowResults(false);
    setPage(1);
  }, [reportType, vehicles, stations, sources, fromDate, toDate]);

  function applyQuickPeriod(value: string) {
    setQuickPeriod(value);
    const today = new Date();
    if (value === "ALL") {
      setFromDate("");
      setToDate("");
      return;
    }
    if (value === "TODAY") {
      const iso = toLocalIsoDate(today);
      setFromDate(iso);
      setToDate(iso);
      return;
    }
    if (value === "YESTERDAY") {
      const date = new Date(today);
      date.setDate(date.getDate() - 1);
      const iso = toLocalIsoDate(date);
      setFromDate(iso);
      setToDate(iso);
      return;
    }
    if (value === "CURRENT_MONTH") {
      setFromDate(toLocalIsoDate(new Date(today.getFullYear(), today.getMonth(), 1)));
      setToDate(toLocalIsoDate(today));
      return;
    }
    if (value === "LAST_MONTH") {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      setFromDate(toLocalIsoDate(start));
      setToDate(toLocalIsoDate(end));
    }
  }

  function downloadReport() {
    const namePeriod = `${fromDate || "all"}_${toDate || "all"}`;
    downloadCsv(`fleet-fuel-${reportType}-${namePeriod}.csv`, rowsForReport);
  }

  return (
    <>
      <div className="fleet-report-page">
        <div>
          <strong>Fleet reports</strong>
          <span>{filtered.length} fuel rows matching selected filters.</span>
        </div>
      </div>
      <div className="fleet-local-filters fleet-report-filters">
        <Field label="Report type">
          <select value={reportType} onChange={(event) => setReportType(event.target.value as FuelReportType)}>
            <option value="transactions">Fuel transactions</option>
            <option value="vehicle">Vehicle summary</option>
            <option value="location">Location summary</option>
          </select>
        </Field>
        <Field label="Period">
          <select value={quickPeriod} onChange={(event) => applyQuickPeriod(event.target.value)}>
            <option value="CUSTOM">Custom</option>
            <option value="TODAY">Today</option>
            <option value="YESTERDAY">Yesterday</option>
            <option value="CURRENT_MONTH">Current month</option>
            <option value="LAST_MONTH">Last month</option>
            <option value="ALL">All dates</option>
          </select>
        </Field>
        <Field label="From date">
          <input type="date" value={fromDate} onChange={(event) => { setQuickPeriod("CUSTOM"); setFromDate(event.target.value); }} />
        </Field>
        <Field label="To date">
          <input type="date" value={toDate} onChange={(event) => { setQuickPeriod("CUSTOM"); setToDate(event.target.value); }} />
        </Field>
        <MultiCheckFilter allLabel="All vehicles" label="Vehicle" onChange={setVehicles} selected={vehicles} values={vehicleOptions} />
        <MultiCheckFilter allLabel="All locations" label="Location" onChange={setStations} selected={stations} values={stationOptions} />
        <MultiCheckFilter allLabel="All sources" label="Fuel source" onChange={setSources} selected={sources} values={sourceOptions} />
        <div className="fleet-report-submit">
          <button className="fleet-btn primary" onClick={() => { setPage(1); setShowResults(true); }} type="button">Submit</button>
        </div>
      </div>
      {showResults ? (
        <div className="fleet-report-results">
          <div className="fleet-report-results-head">
            <div>
              <strong>Report result</strong>
              <span>{reportDataRows.length} rows generated.</span>
            </div>
            <button className="fleet-btn ghost" onClick={downloadReport} type="button">Download</button>
          </div>
          <DataTable headers={reportHeaders} numericFrom={null} rows={pageRows} />
          {reportDataRows.length > 50 ? (
            <div className="fleet-pagination">
              <span>Page {page} of {totalPages}</span>
              <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">Previous</button>
              <button disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} type="button">Next</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function LiveGps({ rows }: { rows: GpsRow[] }) {
  const [search, setSearch] = useState("");
  const [ignition, setIgnition] = useState("ALL");
  const filtered = rows.filter((row) => (
    (!search.trim() || row.vehicle_no.toLowerCase().includes(search.trim().toLowerCase())) &&
    (ignition === "ALL" || (ignition === "ON" ? row.ignition : !row.ignition))
  ));

  return (
    <>
      <div className="fleet-local-filters compact">
        <Field label="Search">
          <input placeholder="Vehicle number" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Field>
        <Field label="Ignition">
          <select value={ignition} onChange={(event) => setIgnition(event.target.value)}>
            <option value="ALL">All</option>
            <option value="ON">ON</option>
            <option value="OFF">OFF</option>
          </select>
        </Field>
      </div>
      <DataTable
        headers={["Vehicle", "Speed", "Ignition", "GPS Time", "Location"]}
        rows={filtered.map((row) => [
          <span className="fleet-vehicle-text" key={row.vehicle_no}>{row.vehicle_no}</span>,
          `${formatNumber(row.speed)} km/h`,
          row.ignition ? "ON" : "OFF",
          formatDashboardDateTime(row.gps_time),
          <a href={`https://maps.google.com/?q=${row.latitude},${row.longitude}`} target="_blank" key="map">Map</a>
        ])}
      />
    </>
  );
}

function TrackingView({
  vehicle,
  date,
  setDate,
  route,
  loading,
  openTracking,
  refreshFleet,
  gpsRows,
  rows
}: {
  vehicle: string;
  date: string;
  setDate: (date: string) => void;
  route: RouteHistory | null;
  loading: boolean;
  openTracking: (vehicle: string) => void;
  refreshFleet: () => void;
  gpsRows: GpsRow[];
  rows: FleetMetric[];
}) {
  const [liveMode, setLiveMode] = useState(false);
  const selectedVehicle = vehicle === "ALL" ? rows[0]?.vehicle_no : vehicle;
  const livePoint = gpsRows.find((row) => row.vehicle_no === selectedVehicle);

  useEffect(() => {
    if (!liveMode) return;
    refreshFleet();
    const timer = window.setInterval(refreshFleet, 10000);
    return () => window.clearInterval(timer);
  }, [liveMode, selectedVehicle]);

  return (
    <div className="fleet-tracking-grid">
      <div className="fleet-side">
        <Field label="Vehicle">
          <select value={selectedVehicle || ""} onChange={(event) => openTracking(event.target.value)}>
            {rows.map((row) => <option key={row.vehicle_no}>{row.vehicle_no}</option>)}
          </select>
        </Field>
        <Field label="Movement Date">
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <div className="fleet-action-stack">
          <button className="fleet-btn primary" onClick={() => openTracking(selectedVehicle || "")} type="button">Load Movement</button>
          <button className={`fleet-btn ${liveMode ? "primary" : "ghost"}`} onClick={() => setLiveMode((value) => !value)} type="button">
            {liveMode ? "Live On" : "Live Movement"}
          </button>
          <a className="fleet-btn ghost" href="https://wheelseye.com/portal/" target="_blank">Open WheelEye Portal</a>
        </div>
        {loading ? <div className="fleet-empty small">Loading WheelEye route...</div> : null}
        {livePoint ? (
          <div className="fleet-stat-list">
            <Stat label="Live Speed" value={`${formatNumber(livePoint.speed)} km/h`} />
            <Stat label="Ignition" value={livePoint.ignition ? "ON" : "OFF"} />
            <Stat label="GPS Time" value={livePoint.gps_time ? formatDateTime(livePoint.gps_time) : "-"} />
          </div>
        ) : liveMode ? (
          <div className="fleet-empty small">No live GPS point available for this vehicle.</div>
        ) : null}
        {route?.summary ? (
          <div className="fleet-stat-list">
            <Stat label="Route KM" value={route.summary.distanceReliable === false ? "Needs review" : formatNumber(route.summary.km)} />
            {route.summary.quality === "filtered" ? <Stat label="GPS quality" value="Filtered" /> : null}
            {route.summary.qualityReason ? <p className="fleet-empty small">{route.summary.qualityReason}</p> : null}
            <Stat label="Max Speed" value={`${formatNumber(route.summary.maxSpeed)} km/h`} />
            <Stat label="Moving Minutes" value={formatNumber(route.summary.movingMinutes)} />
            <Stat label="Points" value={formatNumber(route.summary.pointCount)} />
            <Stat label="Late Night" value={route.summary.lateNight ? "YES" : "NO"} />
          </div>
        ) : null}
        {route?.error ? <div className="fleet-empty small">{route.error}</div> : null}
      </div>
      <RouteMap currentPoint={livePoint ? { lat: livePoint.latitude, lng: livePoint.longitude } : null} points={route?.points ?? []} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="fleet-stat"><span>{label}</span><b>{value}</b></div>;
}

const ROUTE_MAP_WIDTH = 1000;
const ROUTE_MAP_HEIGHT = 620;
const MAP_TILE_SIZE = 256;

function sampleRoutePoints(points: { lat: number; lng: number }[], maxPoints = 1400) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
}

function projectToWorld(point: { lat: number; lng: number }, zoom: number) {
  const scale = MAP_TILE_SIZE * (2 ** zoom);
  const lat = Math.max(Math.min(point.lat, 85.05112878), -85.05112878);
  const sinLat = Math.sin((lat * Math.PI) / 180);

  return {
    x: ((point.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  };
}

function getRouteZoom(points: { lat: number; lng: number }[]) {
  const minLat = Math.min(...points.map((point) => point.lat));
  const maxLat = Math.max(...points.map((point) => point.lat));
  const minLng = Math.min(...points.map((point) => point.lng));
  const maxLng = Math.max(...points.map((point) => point.lng));

  for (let zoom = 16; zoom >= 8; zoom -= 1) {
    const northWest = projectToWorld({ lat: maxLat, lng: minLng }, zoom);
    const southEast = projectToWorld({ lat: minLat, lng: maxLng }, zoom);
    if (
      Math.abs(southEast.x - northWest.x) <= ROUTE_MAP_WIDTH * 0.86 &&
      Math.abs(southEast.y - northWest.y) <= ROUTE_MAP_HEIGHT * 0.86
    ) {
      return zoom;
    }
  }

  return 8;
}

export function RouteMap({
  currentPoint,
  points
}: {
  currentPoint?: { lat: number; lng: number } | null;
  points: { lat: number; lng: number }[];
}) {
  const [zoomOffset, setZoomOffset] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const boundPoints = currentPoint ? [...points, currentPoint] : points;
  const routeSignature = points.length
    ? `${points.length}-${points[0]?.lat},${points[0]?.lng}-${points[points.length - 1]?.lat},${points[points.length - 1]?.lng}`
    : "empty";

  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setZoomOffset(0);
  }, [routeSignature]);

  if (!boundPoints.length) {
    return (
      <div className="fleet-mapbox osm-mapbox">
        <div className="fleet-map-empty">Load movement to view route on map.</div>
      </div>
    );
  }

  const mapPoints = sampleRoutePoints(points);
  const minLat = Math.min(...boundPoints.map((point) => point.lat));
  const maxLat = Math.max(...boundPoints.map((point) => point.lat));
  const minLng = Math.min(...boundPoints.map((point) => point.lng));
  const maxLng = Math.max(...boundPoints.map((point) => point.lng));
  const baseZoom = getRouteZoom(boundPoints);
  const zoom = Math.max(8, Math.min(18, baseZoom + zoomOffset));
  const center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  const centerWorld = projectToWorld(center, zoom);
  const leftWorld = centerWorld.x - ROUTE_MAP_WIDTH / 2 - pan.x;
  const topWorld = centerWorld.y - ROUTE_MAP_HEIGHT / 2 - pan.y;
  const maxTile = 2 ** zoom;
  const tileStartX = Math.floor(leftWorld / MAP_TILE_SIZE);
  const tileEndX = Math.floor((leftWorld + ROUTE_MAP_WIDTH) / MAP_TILE_SIZE);
  const tileStartY = Math.floor(topWorld / MAP_TILE_SIZE);
  const tileEndY = Math.floor((topWorld + ROUTE_MAP_HEIGHT) / MAP_TILE_SIZE);
  const tiles: { key: string; url: string; left: number; top: number }[] = [];

  for (let tileX = tileStartX; tileX <= tileEndX; tileX += 1) {
    for (let tileY = tileStartY; tileY <= tileEndY; tileY += 1) {
      if (tileY < 0 || tileY >= maxTile) continue;
      const wrappedX = ((tileX % maxTile) + maxTile) % maxTile;
      tiles.push({
        key: `${zoom}-${tileX}-${tileY}`,
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
        left: tileX * MAP_TILE_SIZE - leftWorld,
        top: tileY * MAP_TILE_SIZE - topWorld
      });
    }
  }

  const toScreenPoint = (point: { lat: number; lng: number }) => {
    const world = projectToWorld(point, zoom);
    return {
      x: ROUTE_MAP_WIDTH / 2 + (world.x - centerWorld.x) + pan.x,
      y: ROUTE_MAP_HEIGHT / 2 + (world.y - centerWorld.y) + pan.y
    };
  };
  const screenPoints = mapPoints.map(toScreenPoint);
  const routePoints = screenPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const start = screenPoints[0];
  const end = screenPoints[screenPoints.length - 1];
  const live = currentPoint ? toScreenPoint(currentPoint) : null;

  return (
    <div
      className={`fleet-mapbox osm-mapbox${isDragging ? " is-dragging" : ""}`}
      onPointerCancel={() => {
        dragStart.current = null;
        setIsDragging(false);
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest(".fleet-map-controls")) return;
        dragStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDragging(true);
      }}
      onPointerMove={(event) => {
        const start = dragStart.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        dragStart.current = { ...start, x: event.clientX, y: event.clientY };
        setPan((value) => ({ x: value.x + dx, y: value.y + dy }));
      }}
      onPointerUp={(event) => {
        if (dragStart.current?.pointerId === event.pointerId) {
          dragStart.current = null;
          setIsDragging(false);
        }
      }}
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        setZoomOffset((value) => Math.max(-4, Math.min(4, value + (event.deltaY < 0 ? 1 : -1))));
      }}
    >
      <div className="fleet-map-controls" aria-label="Map zoom controls">
        <button onClick={() => setZoomOffset((value) => Math.min(value + 1, 4))} type="button" aria-label="Zoom in">+</button>
        <button onClick={() => setZoomOffset((value) => Math.max(value - 1, -4))} type="button" aria-label="Zoom out">-</button>
        <button onClick={() => { setZoomOffset(0); setPan({ x: 0, y: 0 }); }} type="button" aria-label="Reset zoom">Fit</button>
      </div>
      <div className="fleet-map-tiles" aria-hidden="true">
        {tiles.map((tile) => (
          <img
            alt=""
            className="fleet-map-tile"
            draggable={false}
            key={tile.key}
            src={tile.url}
            style={{ left: tile.left, top: tile.top }}
          />
        ))}
      </div>
      <svg className="fleet-map-route" viewBox={`0 0 ${ROUTE_MAP_WIDTH} ${ROUTE_MAP_HEIGHT}`} preserveAspectRatio="none">
        {routePoints ? <polyline points={routePoints} fill="none" stroke="#cf3f5f" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5" /> : null}
        {start ? <circle cx={start.x} cy={start.y} r="8" fill="#12845c" stroke="#ffffff" strokeWidth="3" /> : null}
        {end ? <circle cx={end.x} cy={end.y} r="8" fill="#cf3f5f" stroke="#ffffff" strokeWidth="3" /> : null}
        {live ? (
          <>
            <circle cx={live.x} cy={live.y} r="15" fill="#2563eb" opacity="0.18" />
            <circle cx={live.x} cy={live.y} r="8" fill="#2563eb" stroke="#ffffff" strokeWidth="3" />
          </>
        ) : null}
      </svg>
      <div className="fleet-map-attribution">© OpenStreetMap</div>
    </div>
  );
}

function Maintenance({ rows }: { rows: MaintenanceRow[] }) {
  const [search, setSearch] = useState("");
  const filtered = rows.filter((row) => (
    !search.trim() ||
    row.vehicle_no.toLowerCase().includes(search.trim().toLowerCase()) ||
    row.issue_type.toLowerCase().includes(search.trim().toLowerCase()) ||
    (row.vendor || "").toLowerCase().includes(search.trim().toLowerCase())
  ));

  return (
    <>
      <div className="fleet-local-filters compact">
        <Field label="Search">
          <input placeholder="Vehicle, issue, vendor" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Field>
      </div>
      <div className="fleet-empty small">Maintenance entry will save to Supabase once env is connected. Current records below.</div>
      <DataTable
        headers={["Date", "Vehicle", "Issue", "Amount", "Vendor", "Bill"]}
        rows={filtered.map((row) => [
          row.date,
          row.vehicle_no,
          row.issue_type,
          formatCurrency(row.amount),
          row.vendor || "-",
          row.bill_url ? <a href={row.bill_url} key="bill">Bill</a> : "-"
        ])}
      />
    </>
  );
}

function DataTable({ headers, numericFrom = 4, rows }: { headers: string[]; numericFrom?: number | null; rows: React.ReactNode[][] }) {
  if (!rows.length) return <div className="fleet-empty">No data for selected filters.</div>;
  return (
    <div className="fleet-table-wrap">
      <table className="fleet-table">
        <thead>
          <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td className={numericFrom !== null && cellIndex >= numericFrom ? "num" : ""} key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sum(rows: FleetMetric[], key: "km" | "litres" | "fuelAmount") {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function groupRows(rows: FleetMetric[], getKey: (row: FleetMetric) => string) {
  const grouped = new Map<string, { key: string; count: number; km: number; litres: number; fuelAmount: number }>();
  rows.forEach((row) => {
    const key = getKey(row);
    const current = grouped.get(key) ?? { key, count: 0, km: 0, litres: 0, fuelAmount: 0 };
    current.count += 1;
    current.km += row.km || 0;
    current.litres += row.litres || 0;
    current.fuelAmount += row.fuelAmount || 0;
    grouped.set(key, current);
  });
  return Array.from(grouped.values());
}

function uniqueValues(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.map((value) => (value || "").trim()).filter(Boolean))).sort();
}

function toLocalIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildFuelReportRows(rows: FuelRow[], type: "transactions" | "vehicle" | "location") {
  if (type === "transactions") {
    return [
      ["Date", "Vehicle", "Station", "Source", "Pump", "Litres", "Amount"],
      ...rows.map((row) => [
        row.transaction_at ? formatDateValue(row.transaction_at.slice(0, 10)) : "-",
        row.vehicle_no,
        row.station_code,
        row.source,
        row.pump_name || "-",
        formatNumber(row.quantity),
        formatReportNumber(row.amount)
      ])
    ];
  }

  const grouped = new Map<string, { key: string; count: number; litres: number; amount: number }>();
  rows.forEach((row) => {
    const key = type === "vehicle" ? row.vehicle_no : row.station_code;
    const current = grouped.get(key) ?? { key, count: 0, litres: 0, amount: 0 };
    current.count += 1;
    current.litres += Number(row.quantity) || 0;
    current.amount += Number(row.amount) || 0;
    grouped.set(key, current);
  });

  return [
    [type === "vehicle" ? "Vehicle" : "Location", "Transactions", "Litres", "Amount"],
    ...Array.from(grouped.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((row) => [row.key, row.count, formatNumber(row.litres), formatReportNumber(row.amount)])
  ];
}

function formatReportNumber(value: number) {
  return (Number(value) || 0).toFixed(2);
}

function downloadCsv(fileName: string, rows: Array<Array<string | number>>) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, "\"\"")}"`).join(","))
    .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

const defaultFleetDocumentTypes: FleetDocumentDefinition[] = [
  { value: "FLEET_REGISTRATION", label: "Registration", requires_expiry: true, reminder_days: 30, sort_order: 10 },
  { value: "FLEET_INSURANCE", label: "Insurance", requires_expiry: true, reminder_days: 30, sort_order: 20 },
  { value: "FLEET_PUC", label: "PUC", requires_expiry: true, reminder_days: 15, sort_order: 30 },
  { value: "FLEET_FITNESS", label: "Fitness", requires_expiry: true, reminder_days: 30, sort_order: 40 },
  { value: "FLEET_TAX", label: "Tax", requires_expiry: true, reminder_days: 30, sort_order: 50 }
];

const documentExpiryFields: Record<string, keyof FleetVehicleForm> = {
  FLEET_REGISTRATION: "registration_expiry",
  FLEET_INSURANCE: "insurance_expiry",
  FLEET_PUC: "puc_expiry",
  FLEET_FITNESS: "fitness_expiry",
  FLEET_TAX: "tax_expiry",
  fleet_registration: "registration_expiry",
  fleet_insurance: "insurance_expiry",
  fleet_puc: "puc_expiry",
  fleet_fitness: "fitness_expiry",
  fleet_tax: "tax_expiry"
};

function documentLabel(value: FleetDocumentType) {
  return defaultFleetDocumentTypes.find((item) => item.value === value)?.label ?? titleCase(value.replace(/_/g, " "));
}

function documentExpiryField(value: FleetDocumentType) {
  return documentExpiryFields[value] ?? null;
}

function getDocumentExpiryValue(form: FleetVehicleForm, value: FleetDocumentType) {
  const field = documentExpiryField(value);
  return field ? form[field] : "";
}

function getDateViewDocumentDate(row: FleetMetric, value: FleetDocumentType) {
  const field = documentExpiryField(value);
  if (!field) return undefined;
  const date = row[field as keyof FleetMetric] as string | undefined;
  return date;
}

function normalizeDocumentTypes(value?: FleetDocumentDefinition[]) {
  const rows = Array.isArray(value) && value.length ? [...value, ...defaultFleetDocumentTypes] : defaultFleetDocumentTypes;
  const seen = new Set<string>();
  return rows
    .map((item, index) => ({
      value: String(item.value ?? "").trim().toUpperCase(),
      label: String(item.label ?? item.value ?? "Document").trim(),
      requires_expiry: item.requires_expiry !== false,
      reminder_days: Number(item.reminder_days) || 0,
      sort_order: Number(item.sort_order ?? index)
    }))
    .filter((item) => item.value && !seen.has(item.value) && seen.add(item.value));
}

function formatNumber(value: number) {
  return (Number(value) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatCurrency(value: number) {
  return `Rs ${(Number(value) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function formatDateValue(value?: string) {
  return formatDashboardDate(value);
}

function formatDateTime(value?: string | null) {
  return formatDashboardDateTime(value, "");
}

function normalizeOptionalDate(value?: string) {
  return value && isIsoDate(value) ? value : "";
}

function getExpiryUrgency(value?: string) {
  if (!isIsoDate(value)) return "normal";
  const days = getDaysUntilExpiry(value);
  if (days < 0) return "expired";
  if (days < 7) return "due-orange";
  if (days < 15) return "due-pink";
  if (days < 30) return "due-yellow";
  return "normal";
}

function getDaysUntilExpiry(value?: string) {
  if (!isIsoDate(value)) return 9999;
  const expiry = new Date(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((expiry.getTime() - today.getTime()) / 86_400_000);
}

function formatDaysLabel(days: number) {
  if (days < 0) return `${Math.abs(days)}d expired`;
  if (days === 0) return "Today";
  return `${days}d left`;
}

function formatExpiryStatusLabel(days: number) {
  if (days < 0) return "Expired";
  if (days <= 30) return `Expire in ${days} day${days === 1 ? "" : "s"}`;
  return "";
}

function dateUrgencyBucket(days: number) {
  if (days < 0) return "expired";
  if (days <= 7) return "due7";
  if (days <= 15) return "due15";
  if (days <= 30) return "due30";
  return "valid";
}

function isIsoDate(value?: string): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function dateInputValue(value?: string) {
  return isIsoDate(value) ? value : "";
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function locationSelectOptions(locations: FleetLocation[], currentValue: string): SearchableSelectOption[] {
  const options = locations.map((location) => ({
    value: location.code,
    label: location.code,
    helper: [location.name, location.provider, location.model].filter(Boolean).join(" - ")
  }));

  if (currentValue && !options.some((option) => option.value === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue, helper: "Current saved value" });
  }

  return options;
}

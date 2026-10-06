"use client";
import { FleetVehicleMeta, FleetVehicleMetadataProvider } from "@/components/fleet-vehicle-meta";
import {adhocVehicleLabel} from '@/lib/adhoc-vehicle-policy';
import {FleetBreakdownRequest} from "@/components/fleet-breakdown-request";
import { OwnerPreviewSwitcher } from "@/components/owner-preview-switcher";
import { FleetSystemLogs } from "@/components/fleet-system-logs";
import { FleetStatusMaster } from "@/components/fleet-status-master";
import { FleetSourceMaster } from "@/components/fleet-source-master";
import { sourceTitle, vehicleSourceTitle } from "@/lib/fleet/vehicle-sources";
import {PaymentVolumeContext} from "@/components/payment-volume-context";
import {PaymentCostSummary} from "@/components/payment-cost-summary";
import type {PaymentVolume} from "@/lib/payment-volume";
import { FleetVehicleContactFields, FleetVehicleContactEditor } from "@/components/fleet-vehicle-contact";
import { documentApplies, sourceApplies, vehicleSources } from "@/lib/fleet/source-policy";

import { FleetVehicleRentFields, FleetVehicleRentEditor } from "@/components/fleet-vehicle-rent";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  BookOpenCheck,
  Check,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  Eye,
  FileCheck2,
  FileText,
  Fuel,
  Gauge,
  GitBranch,
  History,
  BarChart3,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MapPin,
  Mail,
  Menu,
  Pencil,
  Pause,
  Play,
  PlugZap,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Truck,
  Trash2,
  Users,
  Video,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PaymentApprovalActionForm, type PaymentActionResult } from "@/components/payment-approval-action-form";
import { FleetResponsive } from "@/components/fleet-responsive";
import { FleetAuditRuleEditor } from "@/components/fleet-audit-rule-editor";
import { FleetAttentionWorkspace } from "@/components/fleet-attention-workspace";
import { fleetAttention } from "@/lib/fleet/attention";
import { FleetAuditsWorkspace } from "@/components/fleet-audits-workspace";
import { FleetBrand } from "@/components/fleet-brand";
import { FleetAppInstall } from "@/components/fleet-app-install";
import { FleetAdHocCapacity } from "@/components/fleet-adhoc-capacity";
import { FleetDocumentsWorkspace } from "@/components/fleet-documents-workspace";
import { DailyFleetReportView } from "@/components/fleet-daily-report";
import { FleetMultiSelect, type FleetFilterOption } from "@/components/fleet-multi-select";
import { FleetExportButtons } from "@/components/fleet-export-buttons";
import { gpsExceptions, type GpsExceptionReview } from '@/lib/fleet/gps-exceptions';
import { FleetTrackingWorkspace } from "@/components/fleet-tracking-workspace";
import { FleetServiceWorkspace } from "@/components/fleet-service-workspace";
import { FleetReportsWorkspace } from "@/components/fleet-reports-workspace";
import { FleetVehicleLifecycle } from "@/components/fleet-vehicle-lifecycle";
import { FleetVehicleLiveStatus } from "@/components/fleet-vehicle-live-status";
import { SearchableSelect } from "@/components/searchable-select";
import type { FleetAuditTemplate, FleetChecklistItem, FleetControlData, FleetControlPayment, FleetControlVehicle, FleetDocumentDefinition, FleetStatusRecipient, FleetVehicleStatusDefinition, FleetVehicleStatusReason } from "@/lib/fleet-control";
import { buildFleetDailyStatusEmail } from "@/lib/fleet/daily-status-email";

type Section = "attention" | "overview" | "vehicles" | "documents" | "tracking" | "fuel" | "service" | "audits" | "approvals" | "adhoc" | "reports" | "settings" | "masters";

const workspaceSections: Array<{ key: Section; label: string; icon: typeof LayoutDashboard }> = [
  { key: "overview", label: "Command Center", icon: LayoutDashboard },
  { key: "attention", label: "Need Attention", icon: AlertTriangle },
  { key: "vehicles", label: "Vehicles", icon: Truck },
  { key: "documents", label: "Vehicle Documents", icon: FileCheck2 },
  { key: "tracking", label: "Tracking & Efficiency", icon: Gauge },
  { key: "fuel", label: "Fuel", icon: Fuel },
  { key: "service", label: "Service", icon: Wrench },
  { key: "audits", label: "Vehicle Audits", icon: ClipboardCheck },
  { key: "approvals", label: "Vehicle Payments", icon: CircleDollarSign },
  { key: "adhoc", label: "Ad Hoc Usage", icon: Activity },
  { key: "reports", label: "Reports", icon: BarChart3 }
];

const administrationSections: Array<{ key: Section; label: string; icon: typeof LayoutDashboard }> = [
  { key: "settings", label: "Settings", icon: Settings },
  { key: "masters", label: "Masters", icon: BookOpenCheck }
];

const sections = [...workspaceSections, ...administrationSections];

const validSections = new Set(sections.map((section) => section.key));
function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function date(value: string | null | undefined, includeYear = true) {
  if (!value) return "—";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" } : {}),
    timeZone: "Asia/Kolkata"
  }).format(parsed);
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(parsed);
}

function actionLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type FleetPaymentDetail = {
  volume?:PaymentVolume|null;volumeError?:string;volumeDate?:string|null;
  replacement?:{reason:string;number:string;model:string;partner:string|null;source:string;status:string;date:string}|null;
  cost?:{estimate:number|null;actual:number|null;shipments:number|null};
  answers: Array<{ id: string; label: string; value: string }>;
  attachments: Array<{ id: string; label: string; fileName: string }>;
  history: Array<{ id: string; action: string; actor: string; role: string; comments: string; createdAt: string }>;
  currentStage: string | null;
};

function statusTone(status: string) {
  if (status === "active" || status === "approved" || status === "paid") return "good";
  if (status === "under_service" || status === "in approval" || status === "processing") return "warn";
  if (status === "breakdown" || status === "rejected") return "bad";
  return "neutral";
}


function documentMessage(vehicle: FleetControlVehicle) {
  if (vehicle.nextDocumentDays == null) return "Expiry dates incomplete";
  if (vehicle.nextDocumentDays < 0) return `${vehicle.nextDocument} expired ${Math.abs(vehicle.nextDocumentDays)}d ago`;
  if (vehicle.nextDocumentDays === 0) return `${vehicle.nextDocument} expires today`;
  return `${vehicle.nextDocument} in ${vehicle.nextDocumentDays}d`;
}

function FleetScopeFilters({ clusters, onClusters, onRegions, onStations, onStatuses, regions, stationOptions, stations, statusLabel = "Status", statusOptions: statuses = [], statuses: statusValues = [] }: {
  clusters: string[]; onClusters: (values: string[]) => void; onRegions: (values: string[]) => void; onStations: (values: string[]) => void; onStatuses?: (values: string[]) => void;
  regions: string[]; stationOptions: FleetControlData["stationOptions"]; stations: string[]; statusLabel?: string; statusOptions?: FleetFilterOption[]; statuses?: string[];
}) {
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort().map((value) => ({ value, label: value }));
  const filteredStations = stationOptions.filter((station) => (!clusters.length || clusters.includes(station.cluster)) && (!regions.length || regions.includes(station.region)));
  return <div className="fc-scope-filters">
    <FleetMultiSelect allLabel="All regions" label="Region" onChange={onRegions} options={unique(stationOptions.map((station) => station.region))} values={regions} />
    <FleetMultiSelect allLabel="All clusters" label="Cluster" onChange={onClusters} options={unique(stationOptions.map((station) => station.cluster))} values={clusters} />
    <FleetMultiSelect allLabel="All placements" label="Station" onChange={onStations} options={filteredStations.map((station) => ({ value: station.code, label: station.code, helper: station.name }))} values={stations} />
    {onStatuses && statuses.length ? <FleetMultiSelect allLabel={`All ${statusLabel.toLowerCase()}`} label={statusLabel} onChange={onStatuses} options={statuses} values={statusValues} /> : null}
  </div>;
}

function vehicleDisplayName(vehicle: FleetControlVehicle) {
  if (!vehicle.vehicleNo.startsWith('PENDING-')) return vehicle.vehicleNo;
  return (vehicle.ownershipType === 'own' ? '' : vehicle.daName || vehicle.vendorName) || vehicle.model || 'Vehicle';
}
function vehicleDisplayDetail(vehicle: FleetControlVehicle) {
  return [vehicle.model || "Model not recorded", vehicle.stationCode || "Station not mapped", vehicle.vehicleNo.startsWith('PENDING-') ? 'Registration not added' : null].filter(Boolean).join(' · ');
}
export function FleetControlDashboard({
  approveAction,
  data: serverData,
  initialRequestId,
  initialAuditId,
  initialMasterTab,
  initialSection,
  message,
  rejectAction,
  returnAction,
  signOutAction
}: {
  approveAction: (formData: FormData) => Promise<void>;
  data: FleetControlData;
  initialRequestId?: string;
  initialAuditId?: string;
  initialMasterTab?: string;
  initialSection?: string;
  message: { type: "notice" | "error"; text: string } | null;
  rejectAction: (formData: FormData) => Promise<void>;
  returnAction: (formData: FormData) => Promise<void>;
  signOutAction: (formData: FormData) => void | Promise<void>;
}) {
  const router = useRouter();
  const [reviewUpdates,setReviewUpdates] = useState<GpsExceptionReview[]>([]);
  const data = {...serverData,gpsExceptionReviews:[...(serverData.gpsExceptionReviews||[]),...reviewUpdates]};
  const [exceptionEntry,setExceptionEntry] = useState<{target?:{vehicleNo:string;date:string};key:number}|null>(null);
  const openGpsAlerts=gpsExceptions(data,data.today.slice(0,7)+"-01",data.today);
  function openExceptions(target?:{vehicleNo:string;date:string}) { setExceptionEntry({target,key:Date.now()}); changeSection("tracking"); }
  const visibleSectionSet = new Set(data.capabilities.visibleSections as Section[]);
  const firstVisibleSection = sections.find((item) => visibleSectionSet.has(item.key))?.key ?? "overview";
  const requestedSection = validSections.has(initialSection as Section) ? initialSection as Section : firstVisibleSection;
  const [section, setSection] = useState<Section>(visibleSectionSet.has(requestedSection) ? requestedSection : firstVisibleSection);
  const [auditToOpen, setAuditToOpen] = useState<string | null>(initialAuditId || null);
  const [mobileNav, setMobileNav] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [stations, setStations] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [vehicleStatuses, setVehicleStatuses] = useState<string[]>([]);
  const [vehicleOwnerships, setVehicleOwnerships] = useState<string[]>([]);
  const [vehicleDeployments, setVehicleDeployments] = useState<string[]>([]);
  const [paymentStatuses, setPaymentStatuses] = useState<string[]>([]);
  const [paymentHeads, setPaymentHeads] = useState<string[]>([]);
  const [vehicleSort, setVehicleSort] = useState("vehicle");
  const [vehicleView, setVehicleView] = useState<"live" | "registry">("live");
  const [paymentSort, setPaymentSort] = useState("date_desc");
  const [attentionTarget,setAttentionTarget]=useState<{vehicle:string;documentType?:string}|null>(null);
  const [vehicles, setVehicles] = useState(data.vehicles);
  const [payments, setPayments] = useState(data.payments);
  const [movements, setMovements] = useState(data.movements);
  const [selectedVehicle, setSelectedVehicle] = useState<FleetControlVehicle | null>(null);
  const [lifecycleVehicle, setLifecycleVehicle] = useState<FleetControlVehicle | null>(null);
  const [placementStation, setPlacementStation] = useState("");
  const [placementReason, setPlacementReason] = useState("");
  const [deploymentDraft, setDeploymentDraft] = useState<FleetControlVehicle["deploymentStatus"]>("deployed");
  const [currentLocationTypeDraft, setCurrentLocationTypeDraft] = useState<FleetControlVehicle["currentLocationType"]>("station");
  const [currentLocationDraft, setCurrentLocationDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState("");
  const [statusReasonId, setStatusReasonId] = useState("");
  const [statusComment, setStatusComment] = useState("");
  const [statusSince, setStatusSince] = useState("");
  const [expectedOperationalDate, setExpectedOperationalDate] = useState("");
  const [sourceDraft,setSourceDraft] = useState("");
  const sources=data.vehicleSources??[];
  const ownershipDraft=sources.find(s=>s.id===sourceDraft)?.ownershipType??"own";
  const [placementHistoryOpen, setPlacementHistoryOpen] = useState(true);
  const [selectedPayment, setSelectedPayment] = useState<FleetControlPayment | null>(() => data.payments.find((payment) => payment.id === initialRequestId) ?? null);
  const [paymentDetail, setPaymentDetail] = useState<FleetPaymentDetail | null>(null);
  const [paymentDetailError, setPaymentDetailError] = useState("");
  const [paymentDetailLoading, setPaymentDetailLoading] = useState(false);
  const [paymentDetailVersion, setPaymentDetailVersion] = useState(0);
  const [savingVehicle, setSavingVehicle] = useState<string | null>(null);
  const [flash, setFlash] = useState(message);
  const [addVehicle, setAddVehicle] = useState(false);
  const [checklistModal, setChecklistModal] = useState(false);
  const [checklistEditing, setChecklistEditing] = useState<FleetChecklistItem | null>(null);
  const [auditTemplateEditor, setAuditTemplateEditor] = useState<FleetAuditTemplate | null | "new">(null);
  const [documentTypeEditor, setDocumentTypeEditor] = useState<FleetDocumentDefinition | null | "new">(null);
  type MasterTab = "vehicle_audit" | "vehicle_documents" | "vehicle_statuses" | "vehicle_sources";
  type SettingsTab = "general" | "auto_mail" | "system_logs";
  const initialMaster = ["vehicle_audit", "vehicle_documents", "vehicle_statuses", "vehicle_sources"].includes(initialMasterTab ?? "") ? initialMasterTab as MasterTab : "vehicle_audit";
  const [masterTab, setMasterTab] = useState<MasterTab>(initialMaster);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [mailPreviewOpen, setMailPreviewOpen] = useState(false);
  const [mailRegion, setMailRegion] = useState("");
  const mailRegions = [...new Set(data.stationOptions.map(station => station.region))].sort();
  const selectedMailRegion = mailRegion || mailRegions[0] || "Unassigned region";
  const [recipientEditor, setRecipientEditor] = useState<FleetStatusRecipient | null>(null);
  const [adminMenusOpen, setAdminMenusOpen] = useState({ settings: section === "settings", masters: section === "masters" });
  const [statusMasterEditor, setStatusMasterEditor] = useState<{ kind: "status"; item: FleetVehicleStatusDefinition | null } | { kind: "reason"; status: FleetVehicleStatusDefinition; item: FleetVehicleStatusReason | null } | null>(null);
  const [savingAction, setSavingAction] = useState<string | null>(null);

  const stationByCode = useMemo(() => new Map(data.stationOptions.map((item) => [item.code, item])), [data.stationOptions]);
  const [newVehicleSourceId,setNewVehicleSourceId]=useState(data.vehicleSources?.find(s=>s.code==="OWN")?.id??"");
  const newVehicleSource=sources.find(s=>s.id===newVehicleSourceId)?.ownershipType??"own";
  const [newVehicleStatus, setNewVehicleStatus] = useState("active");
  const vehicleStatusOptions = useMemo<FleetVehicleStatusDefinition[]>(() => {
    const configured = data.vehicleStatuses.filter((item) => item.isActive);
    const known = new Set(configured.map((item) => item.key));
    return [...configured, ...vehicles.filter((vehicle, index, list) => !known.has(vehicle.status) && list.findIndex((item) => item.status === vehicle.status) === index).map((vehicle) => ({ id: "", key: vehicle.status, label: vehicle.statusLabel, helper: "Legacy status", tone: "neutral" as const, isOperational: vehicle.status === "active", isTerminal: false, requiresReason: false, requiresExpectedDate: false, sortOrder: 999, isActive: true, reasons: [] }))];
  }, [data.vehicleStatuses, vehicles]);
  const selectedStatusDefinition = vehicleStatusOptions.find((item) => item.key === statusDraft) ?? null;
  const inScope = (stationCode: string) => {
    const station = stationByCode.get(stationCode);
    return (!stations.length || stations.includes(stationCode))
      && (!clusters.length || clusters.includes(station?.cluster ?? "Unassigned cluster"))
      && (!regions.length || regions.includes(station?.region ?? "Unassigned region"));
  };

  useEffect(() => {
    const updateFromUrl = () => {
      const value = new URLSearchParams(window.location.search).get("section") as Section | null;
      setSection(value && validSections.has(value) && visibleSectionSet.has(value) ? value : firstVisibleSection);
      const master = new URLSearchParams(window.location.search).get("master");
      if (["vehicle_audit", "vehicle_documents", "vehicle_statuses", "vehicle_sources"].includes(master ?? "")) setMasterTab(master as MasterTab);
      const settings = new URLSearchParams(window.location.search).get("settings");
      if (["general", "auto_mail", "system_logs"].includes(settings ?? "")) setSettingsTab(settings as SettingsTab);
    };
    updateFromUrl();
    window.addEventListener("popstate", updateFromUrl);
    return () => window.removeEventListener("popstate", updateFromUrl);
  }, []);

  useEffect(() => {
    if (!selectedVehicle) return;
    setPlacementStation(selectedVehicle.stationCode);
    setPlacementReason("");
    setDeploymentDraft(selectedVehicle.deploymentStatus);
    setCurrentLocationTypeDraft(selectedVehicle.currentLocationType);
    setCurrentLocationDraft(selectedVehicle.currentLocationLabel || selectedVehicle.stationCode);
    setStatusDraft(selectedVehicle.status);
    setStatusReasonId(selectedVehicle.statusReasonId ?? "");
    setStatusComment(selectedVehicle.statusComment);
    setStatusSince(selectedVehicle.nonOperationalSince ?? data.today);
    setExpectedOperationalDate(selectedVehicle.expectedOperationalDate ?? "");
    setSourceDraft(selectedVehicle.sourceId??sources.find(s=>s.ownershipType===selectedVehicle.ownershipType)?.id??"");
  }, [selectedVehicle?.vehicleNo]);

  useEffect(() => setVehicles(data.vehicles), [data.vehicles]);
  useEffect(() => setMovements(data.movements), [data.movements]);
  useEffect(() => setPayments(data.payments), [data.payments]);

  useEffect(() => {
    if (!selectedPayment) { setPaymentDetail(null); setPaymentDetailError(""); return; }
    const controller = new AbortController();
    setPaymentDetail(null); setPaymentDetailError(""); setPaymentDetailLoading(true);
    fetch(`/api/fleet-control/payment-detail?requestId=${encodeURIComponent(selectedPayment.id)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load payment evidence and history.");
        setPaymentDetail(payload);
      })
      .catch((error) => { if (error?.name !== "AbortError") setPaymentDetailError(error instanceof Error ? error.message : "Unable to load payment evidence and history."); })
      .finally(() => { if (!controller.signal.aborted) setPaymentDetailLoading(false); });
    return () => controller.abort();
  }, [selectedPayment, paymentDetailVersion]);

  function changeSection(next: Section) {
    if (!visibleSectionSet.has(next)) return;
    setSection(next);
    setMobileNav(false);
    const params = new URLSearchParams(window.location.search);
    params.set("section", next);
    params.delete("notice");
    params.delete("error");
    params.delete("request");
    if (next !== "masters") params.delete("master");
    if (next !== "settings") params.delete("settings");
    window.history.pushState({}, "", `${window.location.pathname}?${params.toString()}`);
  }

  function openMaster(next: MasterTab) {
    if (!visibleSectionSet.has("masters")) return;
    setSection("masters");
    setMasterTab(next);
    setAdminMenusOpen((current) => ({ ...current, masters: true }));
    setMobileNav(false);
    const params = new URLSearchParams(window.location.search);
    params.set("section", "masters");
    params.set("master", next);
    params.delete("notice");
    params.delete("error");
    params.delete("request");
    window.history.pushState({}, "", `${window.location.pathname}?${params.toString()}`);
  }

  function openSettings(next: SettingsTab) {
    if (!visibleSectionSet.has("settings")) return;
    setSection("settings");
    setSettingsTab(next);
    setAdminMenusOpen((current) => ({ ...current, settings: true }));
    setMobileNav(false);
    const params = new URLSearchParams(window.location.search);
    params.set("section", "settings");
    params.set("settings", next);
    params.delete("notice");
    params.delete("error");
    window.history.pushState({}, "", `${window.location.pathname}?${params.toString()}`);
  }

  const sourceCounts=new Map<string,number>();
  for(const v of vehicles){if(!inScope(v.stationCode)|| (vehicleStatuses.length&&!vehicleStatuses.includes(v.status)) || (vehicleDeployments.length&&!vehicleDeployments.includes(v.deploymentStatus)))continue;const q=query.trim().toLowerCase();if(q&&!`${v.vehicleNo} ${v.model} ${v.stationCode} ${v.currentLocationLabel} ${v.statusLabel} ${v.deploymentStatus}`.toLowerCase().includes(q))continue;sourceCounts.set(v.sourceId??v.ownershipType,(sourceCounts.get(v.sourceId??v.ownershipType)??0)+1);}
  const sourceTotal=Array.from(sourceCounts.values()).reduce((a,b)=>a+b,0);
  const filteredVehicles = useMemo(() => vehicles.filter((vehicle) => {
    const needle = query.trim().toLowerCase();
    return inScope(vehicle.stationCode) && (!vehicleStatuses.length || vehicleStatuses.includes(vehicle.status)) && (!vehicleOwnerships.length || vehicleOwnerships.includes(vehicle.sourceId??vehicle.ownershipType)) && (!vehicleDeployments.length || vehicleDeployments.includes(vehicle.deploymentStatus)) && (!needle || `${vehicle.vehicleNo} ${vehicle.model} ${vehicle.stationCode} ${vehicle.currentLocationLabel} ${vehicle.statusLabel} ${vehicle.deploymentStatus}`.toLowerCase().includes(needle));
  }).sort((a, b) => vehicleSort === "placement" ? a.stationCode.localeCompare(b.stationCode) || a.vehicleNo.localeCompare(b.vehicleNo) : vehicleSort === "status" ? a.statusLabel.localeCompare(b.statusLabel) || a.vehicleNo.localeCompare(b.vehicleNo) : vehicleSort === "document" ? (a.nextDocumentDays ?? 9999) - (b.nextDocumentDays ?? 9999) : a.vehicleNo.localeCompare(b.vehicleNo)), [query, stations, clusters, regions, vehicleStatuses, vehicleOwnerships, vehicleDeployments, vehicleSort, vehicles, stationByCode]);

  const filteredPayments = useMemo(() => payments.filter((payment) => {
    const needle = query.trim().toLowerCase();
    return inScope(payment.stationCode) && (!paymentStatuses.length || paymentStatuses.includes(payment.statusLabel)) && (!paymentHeads.length || paymentHeads.includes(payment.head)) && (!needle || `${payment.requestNo} ${payment.head} ${payment.stationCode} ${payment.requestedBy} ${payment.statusLabel}`.toLowerCase().includes(needle));
  }).sort((a, b) => paymentSort === "amount_desc" ? b.amount - a.amount : paymentSort === "placement" ? a.stationCode.localeCompare(b.stationCode) : paymentSort === "head" ? a.head.localeCompare(b.head) : b.requestedAt.localeCompare(a.requestedAt)), [payments, paymentSort, query, stations, clusters, regions, paymentStatuses, paymentHeads, stationByCode]);

  const filteredAudits = useMemo(() => data.audits.filter((item) => {
    const needle = query.trim().toLowerCase();
    return inScope(item.stationCode) && (!needle || `${item.vehicleNo} ${item.stationCode} ${item.status} ${item.scheduledReason}`.toLowerCase().includes(needle));
  }), [data.audits, query, stations, clusters, regions, stationByCode]);
  const auditVehicles = useMemo(() => vehicles.filter((vehicle) => {
    const needle = query.trim().toLowerCase();
    return inScope(vehicle.stationCode) && (!needle || `${vehicle.vehicleNo} ${vehicle.model} ${vehicle.daName||""} ${vehicle.vendorName||""} ${vehicle.stationCode} ${vehicle.statusLabel}`.toLowerCase().includes(needle));
  }), [vehicles, query, stations, clusters, regions, stationByCode]);

  const active = vehicles.filter((vehicle) => vehicle.status === "active" && vehicle.deploymentStatus === "deployed").length;
  const underService = vehicles.filter((vehicle) => ["under_service", "breakdown"].includes(vehicle.status)).length;
  const availability = vehicles.length ? Math.round((active / vehicles.length) * 100) : 0;
  const pendingPayments = payments.filter((payment) => payment.canApprove);
  const attentionVehicles = vehicles.filter((vehicle) => (vehicle.nextDocumentDays != null && vehicle.nextDocumentDays <= 30) || data.documentTypes.filter(type=>documentApplies(type,vehicle)).some((type) => !data.documents.some((document) => document.vehicleNo === vehicle.vehicleNo && document.documentType === type.value)));
  const todayAdHoc = data.adHocRows.filter((row) => row.date === data.today);
  const todayAudits = data.audits.filter((audit) => audit.scheduledFor === data.today && ["scheduled", "in_progress"].includes(audit.status));

  async function updateVehicleStatus(vehicle: FleetControlVehicle) {
    const option = vehicleStatusOptions.find((item) => item.key === statusDraft);
    if (!option) return;
    if (option.requiresReason && !statusReasonId) { setFlash({ type: "error", text: `Choose a reason for ${option.label}.` }); return; }
    if (option.requiresExpectedDate && !expectedOperationalDate) { setFlash({ type: "error", text: `Add the expected operational date for ${option.label}.` }); return; }
    const reason = option.reasons.find((item) => item.id === statusReasonId) ?? null;
    setSavingVehicle(vehicle.vehicleNo);
    setFlash(null);
    try {
      const response = await fetch("/api/fleet/vehicles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_no: vehicle.vehicleNo, status: option.key, source_id: sourceDraft, non_operational_since: option.isOperational ? null : statusSince, expected_operational_date: option.isOperational ? null : expectedOperationalDate, status_reason_id: option.isOperational ? null : statusReasonId || null, status_comment: option.isOperational ? null : statusComment })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Vehicle status could not be updated.");
      const updated = { status: option.key, statusLabel: option.label, ownershipType: ownershipDraft, sourceId:sourceDraft,sourceCode:sources.find(s=>s.id===sourceDraft)?.code,sourceName:sources.find(s=>s.id===sourceDraft)?.name, nonOperationalSince: option.isOperational ? null : statusSince, expectedOperationalDate: option.isOperational ? null : expectedOperationalDate, statusComment: option.isOperational ? "" : statusComment, statusReasonId: option.isOperational ? null : reason?.id ?? null, statusReasonKey: option.isOperational ? "" : reason?.key ?? "", statusReasonLabel: option.isOperational ? "" : reason?.label ?? "" };
      setVehicles((current) => current.map((row) => row.vehicleNo === vehicle.vehicleNo ? { ...row, ...updated } : row));
      setSelectedVehicle((current) => current?.vehicleNo === vehicle.vehicleNo ? { ...current, ...updated } : current);
      setFlash({ type: "notice", text: `${vehicle.vehicleNo} marked ${option.label.toLowerCase()}.` });
      router.refresh();
    } catch (error) {
      setFlash({ type: "error", text: error instanceof Error ? error.message : "Vehicle status could not be updated." });
    } finally {
      setSavingVehicle(null);
    }
  }

  async function updateVehiclePlacement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedVehicle || !placementStation || !currentLocationDraft.trim()) return;
    const previousStation = selectedVehicle.stationCode;
    const previousLocation = selectedVehicle.currentLocationLabel || selectedVehicle.stationCode;
    const locationNeedle = currentLocationDraft.trim().toLowerCase();
    const matchedLocation = data.stationOptions.find((item) => item.code.toLowerCase() === locationNeedle || item.name.toLowerCase() === locationNeedle || `${item.code} · ${item.name}`.toLowerCase() === locationNeedle);
    const currentLocationLabel = matchedLocation ? `${matchedLocation.code} · ${matchedLocation.name}` : currentLocationDraft.trim();
    const changed = placementStation !== selectedVehicle.stationCode || deploymentDraft !== selectedVehicle.deploymentStatus || currentLocationTypeDraft !== selectedVehicle.currentLocationType || currentLocationLabel !== previousLocation;
    if (!changed) return;
    setSavingVehicle(selectedVehicle.vehicleNo); setFlash(null);
    try {
      const response = await fetch("/api/fleet/vehicles", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vehicle_no: selectedVehicle.vehicleNo, station_code: placementStation, deployment_status: deploymentDraft, current_location_type: currentLocationTypeDraft, current_location_code: matchedLocation?.code ?? null, current_location_label: currentLocationLabel, transfer_date: data.today, transfer_reason: placementReason }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Vehicle placement could not be updated.");
      const updated = { stationCode: placementStation, deploymentStatus: deploymentDraft, currentLocationType: currentLocationTypeDraft, currentLocationCode: matchedLocation?.code ?? "", currentLocationLabel, currentLocationUpdatedAt: new Date().toISOString() };
      setVehicles((current) => current.map((vehicle) => vehicle.id === selectedVehicle.id ? { ...vehicle, ...updated } : vehicle));
      setSelectedVehicle((current) => current ? { ...current, ...updated } : current);
      setMovements((current) => [{ id: `local-${Date.now()}`, vehicleId: selectedVehicle.id, vehicleNo: selectedVehicle.vehicleNo, fromStation: previousLocation, toStation: currentLocationLabel, reason: placementReason || `${deploymentDraft === "not_deployed" ? "Marked not deployed" : "Deployment location updated"}${previousStation !== placementStation ? ` · assigned station ${previousStation} to ${placementStation}` : ""}`, movedAt: new Date().toISOString(), movedBy: data.operator.name }, ...current]);
      setFlash({ type: "notice", text: `${selectedVehicle.vehicleNo} updated: ${deploymentDraft === "not_deployed" ? "not deployed" : "deployed"} · ${currentLocationLabel}.` });
      setPlacementReason(""); router.refresh();
    } catch (error) { setFlash({ type: "error", text: error instanceof Error ? error.message : "Vehicle placement could not be updated." }); }
    finally { setSavingVehicle(null); }
  }

  async function createVehicle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSavingVehicle("NEW");
    setFlash(null);
    try {
      const body = Object.fromEntries(form.entries());
      const response = await fetch("/api/fleet/vehicles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Vehicle could not be added.");
      setAddVehicle(false);
      setFlash({ type: "notice", text: `${String(body.vehicle_no).toUpperCase()} added to Fleet Control.` });
      router.refresh();
    } catch (error) {
      setFlash({ type: "error", text: error instanceof Error ? error.message : "Vehicle could not be added." });
    } finally {
      setSavingVehicle(null);
    }
  }

  async function fleetAction(action: string, payload: Record<string, unknown>, close?: () => void) {
    setSavingAction(action); setFlash(null);
    try {
      const response = await fetch("/api/fleet-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Fleet action could not be completed.");
      close?.(); setFlash({ type: "notice", text: result.message || "Fleet action completed." }); router.refresh(); return true;
    } catch (error) { setFlash({ type: "error", text: error instanceof Error ? error.message : "Fleet action could not be completed." }); return false; }
    finally { setSavingAction(null); }
  }

  async function submitChecklist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const action = checklistEditing ? "checklist.update" : "checklist.create";
    await fleetAction(action, { ...Object.fromEntries(form.entries()), itemId: checklistEditing?.id, isRequired: form.get("isRequired") === "on", failRemarksRequired: form.get("failRemarksRequired") === "on" }, () => { setChecklistModal(false); setChecklistEditing(null); });
  }
  function openChecklist(item: FleetChecklistItem | null = null) { setChecklistEditing(item); setChecklistModal(true); }
  async function removeChecklist(item: FleetChecklistItem) {
    if (!window.confirm(`Remove “${item.label}” from future vehicle audits? Existing audit history will remain unchanged.`)) return;
    await fleetAction("checklist.remove", { itemId: item.id });
  }
  async function submitAuditTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const item = auditTemplateEditor && auditTemplateEditor !== "new" ? auditTemplateEditor : null;
    await fleetAction("audit-template.upsert", { ...Object.fromEntries(form.entries()), id: item?.id, isDefault: form.get("isDefault") === "on" }, () => setAuditTemplateEditor(null));
  }
  async function removeAuditTemplate(item: FleetAuditTemplate) {
    if (!window.confirm(`Remove “${item.name}”? Templates already used for audits will be retained.`)) return;
    await fleetAction("audit-template.remove", { id: item.id });
  }
  async function submitDocumentType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const item = documentTypeEditor && documentTypeEditor !== "new" ? documentTypeEditor : null;
    await fleetAction("document-type.upsert", { ownershipTypes: form.getAll("ownershipTypes"), ...Object.fromEntries(form.entries()), id: item?.id }, () => setDocumentTypeEditor(null));
  }
  async function removeDocumentType(item: FleetDocumentDefinition) {
    if (!item.id || !window.confirm(`Remove “${item.label}” from future vehicle document choices?`)) return;
    await fleetAction("document-type.remove", { id: item.id });
  }
  async function submitStatusMaster(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!statusMasterEditor || statusMasterEditor.kind !== "status") return;
    const form = new FormData(event.currentTarget);
    await fleetAction("vehicle-status.upsert", { ownershipTypes: form.getAll("ownershipTypes"), ...Object.fromEntries(form.entries()), id: statusMasterEditor.item?.id, isOperational: form.get("isOperational") === "on", isTerminal: form.get("isTerminal") === "on", requiresReason: form.get("requiresReason") === "on", requiresExpectedDate: form.get("requiresExpectedDate") === "on" }, () => setStatusMasterEditor(null));
  }
  async function submitStatusReason(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!statusMasterEditor || statusMasterEditor.kind !== "reason") return;
    const form = new FormData(event.currentTarget);
    await fleetAction("vehicle-status-reason.upsert", { ...Object.fromEntries(form.entries()), id: statusMasterEditor.item?.id, statusId: statusMasterEditor.status.id }, () => setStatusMasterEditor(null));
  }
  async function removeVehicleStatus(item: FleetVehicleStatusDefinition) {
    if (!window.confirm(`Remove “${item.label}” from new availability updates?`)) return;
    await fleetAction("vehicle-status.remove", { id: item.id });
  }
  async function removeVehicleStatusReason(item: FleetVehicleStatusReason) {
    if (!window.confirm(`Remove “${item.label}” from the reason list?`)) return;
    await fleetAction("vehicle-status-reason.remove", { id: item.id });
  }
  async function submitSettings(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await fleetAction("settings.update", { ...Object.fromEntries(form.entries()), autoSuggestAudits: form.get("autoSuggestAudits") === "on", auditEmailEnabled: form.get("auditEmailEnabled") === "on", auditVideoRequired: form.get("auditVideoRequired") === "on", breakdownVehicleLinkRequired: form.get("breakdownVehicleLinkRequired") === "on" }); }
  async function submitAuditProgrammeSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await fleetAction("settings.update-audit-programme", { auditProgramme: { enabled: form.get("enabled") === "on", physicalPerMonth: form.get("physicalPerMonth"), virtualPerMonth: form.get("virtualPerMonth"), excludedWeekdays: form.getAll("excludedWeekdays").map(Number), maxPhysicalPerDay: form.get("maxPhysicalPerDay"), maxVirtualPerDay: form.get("maxVirtualPerDay"), minGapDays: form.get("minGapDays"), maxPhysicalStationsPerDay: form.get("maxPhysicalStationsPerDay"), nearbyStationKm: form.get("nearbyStationKm"), autoMoveForLeave: form.get("autoMoveForLeave") === "on", emailTitle: form.get("emailTitle"), emailSubjectPrefix: form.get("emailSubjectPrefix"), primaryColor: form.get("primaryColor"), accentColor: form.get("accentColor"), alertColor: form.get("alertColor"), includeEvidence: form.get("includeEvidence") === "on" } });
  }
  async function submitMailSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await fleetAction("settings.update-mail", {
      dailyStatusEmailEnabled: form.get("dailyStatusEmailEnabled") === "on",
      dailyStatusSendTime: form.get("dailyStatusSendTime"),
      dailyStatusOnlyAffected: form.get("dailyStatusOnlyAffected") === "on",
      dailyStatusEmailConfig: {
        title: form.get("title"), subjectPrefix: form.get("subjectPrefix"), headerLabel: form.get("headerLabel"), intro: form.get("intro"), footer: form.get("footer"),
        primaryColor: form.get("primaryColor"), accentColor: form.get("accentColor"), alertColor: form.get("alertColor"),
        includeSummary: form.get("includeSummary") === "on", includeStationTable: form.get("includeStationTable") === "on", includeNonOperationalTable: form.get("includeNonOperationalTable") === "on", includeAdHoc: form.get("includeAdHoc") === "on",
        includeMappedOperations: form.get("includeMappedOperations") === "on", includeAllLocationOperations: form.get("includeAllLocationOperations") === "on", includeStationMailboxes: form.get("includeStationMailboxes") === "on",
        monthlyThread: form.get("monthlyThread") === "on", excludeAmazonNow: form.get("excludeAmazonNow") === "on",
        excludedStationCodes: String(form.get("excludedStationCodes") ?? "").split(",").map((value) => value.trim()).filter(Boolean)
      }
    });
  }
  async function submitStatusRecipient(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await fleetAction("status-recipient.upsert", { recipientId: recipientEditor?.id, name: form.get("name"), email: form.get("email"), stationCodes: String(form.get("stationCodes") ?? "").split(",").map((value) => value.trim()).filter(Boolean) }, () => { event.currentTarget.reset(); setRecipientEditor(null); }); }
  async function toggleStatusRecipient(recipientId: string, isActive: boolean) { await fleetAction("status-recipient.toggle", { recipientId, isActive }); }
  async function deleteStatusRecipient(recipientId: string, name: string) { if (!window.confirm(`Delete ${name} from the daily Fleet mail list?`)) return; await fleetAction("status-recipient.delete", { recipientId }); }

  const dailyMailPreview = useMemo(() => {
    const excludedCodes = new Set(data.settings.dailyStatusEmailConfig.excludedStationCodes);
    const regionStations = new Set(data.stationOptions.filter(station => station.region === selectedMailRegion).map(station => station.code));
    const activeVehicles = vehicles.filter((vehicle) => !["sold", "disposed", "returned"].includes(vehicle.status) && !excludedCodes.has(vehicle.stationCode) && regionStations.has(vehicle.stationCode));
    const approvedStates = new Set(["approved", "final_approved", "processing", "processed", "paid"]);
    const monthStart = `${data.today.slice(0, 7)}-01`;
    const monthAdHoc = data.adHocRows.filter((row) => row.date >= monthStart && row.date <= data.today && !excludedCodes.has(row.stationCode) && regionStations.has(row.stationCode));
    const approvedAdHoc = monthAdHoc.filter((row) => row.source === "Cashbook" || approvedStates.has(row.approvalStatus));
    const pendingAdHoc = monthAdHoc.filter((row) => row.source !== "Cashbook" && ["pending", "re_pending", "submitted", "resubmitted", "under_review", "awaiting_approval"].includes(row.approvalStatus));
    const todayAdHoc = approvedAdHoc.filter((row) => row.date === data.today);
    const todayPendingAdHoc = pendingAdHoc.filter((row) => row.date === data.today);
    const approvedVans = todayAdHoc.filter((row) => row.requestType === "Van");
    const adHocKeys = [...new Set([...approvedAdHoc, ...pendingAdHoc].map((row) => `${row.stationCode}|${row.requestType}`))];
    const adHocRows = adHocKeys.map((key) => { const [station, typeValue] = key.split("|"); const type = typeValue as "Van" | "Driver"; const todayRows = todayAdHoc.filter((row) => row.stationCode === station && row.requestType === type); const todayPendingRows = todayPendingAdHoc.filter((row) => row.stationCode === station && row.requestType === type); const pendingRows = pendingAdHoc.filter((row) => row.stationCode === station && row.requestType === type); const mtdRows = approvedAdHoc.filter((row) => row.stationCode === station && row.requestType === type); return { station, type, todayCount: todayRows.length, todayAmount: todayRows.reduce((sum, row) => sum + row.amount, 0), todayPendingCount: todayPendingRows.length, todayPendingAmount: todayPendingRows.reduce((sum, row) => sum + row.amount, 0), pendingCount: pendingRows.length, pendingAmount: pendingRows.reduce((sum, row) => sum + row.amount, 0), mtdCount: mtdRows.length, mtdAmount: mtdRows.reduce((sum, row) => sum + row.amount, 0) }; });
    const codes = [...new Set([...activeVehicles.map((vehicle) => vehicle.stationCode), ...approvedAdHoc.map((row) => row.stationCode), ...pendingAdHoc.map((row) => row.stationCode)])];
    const rows = codes.map((station) => { const stationVehicles = activeVehicles.filter((vehicle) => vehicle.stationCode === station); const own = stationVehicles.filter((vehicle) => vehicle.ownershipType === "own"); const partner = stationVehicles.filter((vehicle) => vehicle.ownershipType !== "own"); const ownOperational = own.filter((vehicle) => vehicle.status === "active").length; const partnerOperational = partner.filter((vehicle) => vehicle.status === "active").length; return { station, ownTotal: own.length, ownOperational, ownNonOperational: own.length - ownOperational, partnerTotal: partner.length, partnerOperational, partnerNonOperational: partner.length - partnerOperational, totalNonOperational: stationVehicles.filter((vehicle) => vehicle.status !== "active").length, adHocVans: approvedVans.filter((row) => row.stationCode === station).length }; });
    const fleetRows = rows.filter((row) => row.ownTotal + row.partnerTotal > 0);
    return buildFleetDailyStatusEmail({ companyName: data.operator.company, region: selectedMailRegion, date: data.today, rows: fleetRows, exceptions: activeVehicles.filter((vehicle) => vehicle.status !== "active").map((vehicle) => ({ vehicle_no: vehicle.vehicleNo, station_code: vehicle.stationCode, model: vehicle.model, ownership_type: vehicle.ownershipType, status: vehicle.status, non_operational_since: vehicle.nonOperationalSince, expected_operational_date: vehicle.expectedOperationalDate, status_comment: vehicle.statusComment, status_reason_key: vehicle.statusReasonKey })), adHocRows, totals: { totalVehicles: fleetRows.reduce((sum, row) => sum + row.ownTotal + row.partnerTotal, 0), operational: fleetRows.reduce((sum, row) => sum + row.ownOperational + row.partnerOperational, 0), nonOperational: fleetRows.reduce((sum, row) => sum + row.totalNonOperational, 0), adHoc: todayAdHoc.length, adHocPending: todayPendingAdHoc.length, stationCount: fleetRows.length }, config: data.settings.dailyStatusEmailConfig });
  }, [vehicles, data.adHocRows, data.today, data.operator.company, data.settings.dailyStatusEmailConfig, data.stationOptions, selectedMailRegion]);

  const title = sections.find((item) => item.key === section)?.label ?? "Command Center";
  const scopeProps = { clusters, onClusters: setClusters, onRegions: setRegions, onStations: setStations, regions, stationOptions: data.stationOptions, stations };
  const uniqueOptions = (values: string[]) => [...new Set(values.filter(Boolean))].sort().map((value) => ({ value, label: actionLabel(value) }));

  function finishPaymentAction(result: PaymentActionResult) {
    if (!selectedPayment) return;
    const updated = { ...selectedPayment, canApprove: false, status: result.status, statusLabel: result.statusLabel };
    setPayments((current) => current.map((payment) => payment.id === updated.id ? updated : payment));
    setSelectedPayment(updated);
    setPaymentDetailVersion((value) => value + 1);
    setFlash({ type: "notice", text: result.message });
  }

  return (
    <FleetVehicleMetadataProvider vehicles={vehicles}><main className="fc-app"><FleetResponsive />
      <aside className={`fc-sidebar ${mobileNav ? "open" : ""}`}>
        <button aria-label="Close navigation" className="fc-nav-close" onClick={() => setMobileNav(false)} type="button"><X size={20} /></button>
        <div className="fc-brand"><FleetBrand compact /></div>
        <div className="fc-nav-label">Workspace</div>
        <nav className="fc-nav">
          {workspaceSections.filter((item) => visibleSectionSet.has(item.key)).map((item) => {
            const Icon = item.icon;
            const badge = item.key === "approvals" && pendingPayments.length ? pendingPayments.length : item.key === "audits" && data.counts.auditsDue ? data.counts.auditsDue : item.key === "adhoc" && todayAdHoc.length ? todayAdHoc.length : null;
            return <button className={section === item.key ? "active" : ""} key={item.key} onClick={() => changeSection(item.key)} type="button"><Icon size={18} /><span>{item.label}</span>{badge ? <em>{badge}</em> : null}</button>;
          })}
        </nav>
        <div className="fc-nav-label fc-nav-label-admin">Administration</div>
        <nav className="fc-nav">
          {visibleSectionSet.has("settings") || data.capabilities.canAccessUsers ? <div className="fc-nav-group">
            <button className={section === "settings" ? "active" : ""} onClick={() => setAdminMenusOpen((current) => ({ ...current, settings: !current.settings }))} type="button"><Settings size={18} /><span>Settings</span><ChevronDown className={adminMenusOpen.settings ? "open" : ""} size={15} /></button>
            {adminMenusOpen.settings ? <div className="fc-nav-children">
              {visibleSectionSet.has("settings") ? <button className={section === "settings" && settingsTab === "general" ? "active" : ""} onClick={() => openSettings("general")} type="button"><Settings size={15} />General Settings</button> : null}
              {visibleSectionSet.has("settings") ? <button className={section === "settings" && settingsTab === "auto_mail" ? "active" : ""} onClick={() => openSettings("auto_mail")} type="button"><Mail size={15} />Auto Mail Scheduler</button> : null}
              {visibleSectionSet.has("settings") ? <button className={section === "settings" && settingsTab === "system_logs" ? "active" : ""} onClick={()=>openSettings("system_logs")} type="button"><History size={15}/>System Logs</button> : null}
              {data.capabilities.canAccessUsers ? <a href="/users?section=users"><Users size={15} /><span>Users</span></a> : null}
              {data.capabilities.canAccessUsers ? <a href="/users?section=roles"><ShieldCheck size={15} /><span>User Roles</span></a> : null}
            </div> : null}
          </div> : null}
          {visibleSectionSet.has("masters") ? <div className="fc-nav-group">
            <button className={section === "masters" ? "active" : ""} onClick={() => setAdminMenusOpen((current) => ({ ...current, masters: !current.masters }))} type="button"><BookOpenCheck size={18} /><span>Masters</span><ChevronDown className={adminMenusOpen.masters ? "open" : ""} size={15} /></button>
            {adminMenusOpen.masters ? <div className="fc-nav-children">
              <button className={section === "masters" && masterTab === "vehicle_audit" ? "active" : ""} onClick={() => openMaster("vehicle_audit")} type="button"><ClipboardCheck size={15} />Vehicle Audit</button>
              <button className={section === "masters" && masterTab === "vehicle_documents" ? "active" : ""} onClick={() => openMaster("vehicle_documents")} type="button"><FileCheck2 size={15} />Vehicle Documents</button>
              <button className={section === "masters" && masterTab === "vehicle_statuses" ? "active" : ""} onClick={() => openMaster("vehicle_statuses")} type="button"><Truck size={15} />Vehicle Statuses</button>
              <button className={section === "masters" && masterTab === "vehicle_sources" ? "active" : ""} onClick={() => openMaster("vehicle_sources")} type="button"><Truck size={15} />Vehicle Sources</button>
            </div> : null}
          </div> : null}
        </nav>
        <div className="fc-sidebar-spacer" />
        <section className="fc-system-card">
          <span><i /> Live data</span>
          <strong>{data.stationOptions.length} stations connected</strong>
          <small>Updated {new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(data.generatedAt))}</small>
        </section>
        <div className="fc-user-menu">
          <button aria-expanded={userMenuOpen} className="fc-user-card fc-user-trigger" onClick={() => setUserMenuOpen((current) => !current)} type="button">
            <span>{data.operator.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{data.operator.name}</strong><small>{data.operator.role}</small></div>
            <ChevronDown className={userMenuOpen ? "open" : ""} size={17} />
          </button>
          {userMenuOpen ? <form action={signOutAction} className="fc-user-popover"><button type="submit"><LogOut size={16} /> Sign out</button></form> : null}
        </div>
      </aside>

      {mobileNav ? <button aria-label="Close navigation overlay" className="fc-overlay" onClick={() => setMobileNav(false)} type="button" /> : null}

      <section className="fc-workspace">
        <header className="fc-topbar">
          <button aria-label="Open navigation" className="fc-menu" onClick={() => setMobileNav(true)} type="button"><Menu size={20} /></button>
          <div><span>Fleet Control</span><strong>{title}</strong></div>
          <label className="fc-search"><Search size={17} /><input onChange={(event) => setQuery(event.target.value)} placeholder="Search vehicle, station or request" value={query} /></label>
          {data.preview?.canPreview ? <OwnerPreviewSwitcher active={data.preview.active} name={data.preview.name}/> : null}
          <form action={signOutAction} className="fc-mobile-sign-out"><button aria-label="Sign out" title="Sign out" type="submit"><LogOut size={18} /><span>Sign out</span></button></form>
          <button aria-label="Need Attention" className="fc-icon-button" onClick={() => changeSection(visibleSectionSet.has("attention") ? "attention" : firstVisibleSection)} type="button"><Bell size={18} />{pendingPayments.length ? <i /> : null}</button>
        </header>

        <div className="fc-content">
          {flash ? <div className={`fc-flash ${flash.type}`}><span>{flash.type === "notice" ? <Check size={17} /> : <AlertTriangle size={17} />}{flash.text}</span><button aria-label="Dismiss" onClick={() => setFlash(null)} type="button"><X size={16} /></button></div> : null}
          {data.errors.length ? <div className="fc-flash error"><span><AlertTriangle size={17} />Some live data is unavailable: {data.errors[0]}</span></div> : null}

          {section === "attention" ? <FleetAttentionWorkspace data={{...data,vehicles}} onRentSaved={(id,values)=>setVehicles(current=>current.map(v=>v.id===id?{...v,...values}:v))} onChanged={() => router.refresh()} onNavigate={(item) => { setAttentionTarget({vehicle:item.vehicle,documentType:item.documentType}); if(item.section === "vehicles") setSelectedVehicle(vehicles.find(v=>v.id===item.vehicleId) || null); else if(item.section === "tracking") openExceptions({vehicleNo:item.vehicle,date:item.due||data.today}); else { if(item.auditId) setAuditToOpen(item.auditId); changeSection(item.section as Section); } }} /> : null}
          {section === "overview" ? <>
            {visibleSectionSet.has("attention") ? <button type="button" className="fc-attention-banner" onClick={() => changeSection("attention")}><AlertTriangle size={22}/><span><strong>{fleetAttention({...data,vehicles}).filter(r=>!r.resolved).length} actions need attention</strong><small>Repair follow-ups, overdue returns, documents and audits</small></span><ArrowRight size={20}/></button> : null}
            <section className="fc-hero">
              <div>
                <span className="fc-eyebrow"><ShieldCheck size={14} /> Fleet operations · {date(data.today)}</span>
                <h1>Keep every vehicle moving.</h1>
                <p>One control room for availability, vehicle expenses, documents and daily ad-hoc van demand.</p>
              </div>
              <div className="fc-hero-actions">
                <FleetAppInstall compact />
                <button className="fc-button secondary" onClick={() => changeSection("tracking")} type="button"><Gauge size={16} /> Live GPS & mileage</button>
                {data.capabilities.canAddVehicles ? <button className="fc-button primary" onClick={() => setAddVehicle(true)} type="button"><Plus size={17} /> Add vehicle</button> : null}
              </div>
            </section>

            <section className="fc-kpis">
              <article><span className="mint"><Truck size={19} /></span><div><small>Fleet availability</small><strong>{availability}%</strong><p>{active} of {vehicles.length} vehicles active</p></div><b className="up">Live</b></article>
              <article><span className="amber"><Wrench size={19} /></span><div><small>Owned · service / breakdown</small><strong>{vehicles.filter(v => v.ownershipType === "own" && ["under_service", "breakdown"].includes(v.status)).length}</strong><p>{vehicles.filter((vehicle) => vehicle.ownershipType === "own" && vehicle.status === "breakdown").length} breakdown today</p></div><b>Action</b></article>
              <article><span className="blue"><CircleDollarSign size={19} /></span><div><small>Awaiting your approval</small><strong>{money(data.counts.pendingAmount)}</strong><p>{pendingPayments.length} vehicle payment requests</p></div><b className={pendingPayments.length ? "hot" : "up"}>{pendingPayments.length ? "Review" : "Clear"}</b></article>
              <article><span className="purple"><Activity size={19} /></span><div><small>Ad Hoc usage today</small><strong>{todayAdHoc.length}</strong><p>{todayAdHoc.filter((row) => row.requestType === "Van").length} vans · {todayAdHoc.filter((row) => row.requestType === "Driver").length} drivers</p></div><b>View only</b></article>
            </section>

            {visibleSectionSet.has("tracking") && openGpsAlerts.length > 0 ? <button className="fc-command-exception alert" onClick={() => openExceptions(openGpsAlerts.length===1 ? {vehicleNo:openGpsAlerts[0].vehicleNo,date:openGpsAlerts[0].date} : undefined)} type="button"><span><ShieldCheck size={18} /></span><div><small>Open GPS exceptions · month to date</small><strong>{openGpsAlerts.length} after-hours {openGpsAlerts.length===1?"movement":"movements"}</strong><p>Review recorded locations and operating times, then acknowledge with remarks.</p></div><ArrowRight size={17} /></button> : null}

            <section className="fc-overview-grid">
              <article className="fc-panel fc-today-audit-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Today&apos;s assurance route</span><h2>Physical and virtual audits</h2><p>{todayAudits.filter((audit) => audit.auditMode === "physical").length} physical · {todayAudits.filter((audit) => audit.auditMode === "video").length} virtual</p></div><button onClick={() => changeSection("audits")} type="button">Open programme <ArrowRight size={15} /></button></div>
                <div className="fc-command-audits">{todayAudits.map((audit) => <button className={audit.auditMode} key={audit.id} onClick={() => changeSection("audits")} type="button"><span>{audit.auditMode === "physical" ? <Users size={17} /> : <Video size={17} />}</span><div><strong>{audit.vehicleNo}</strong><FleetVehicleMeta vehicleNo={audit.vehicleNo} stationCode={audit.stationCode}/><small>{audit.auditMode === "physical" ? "Physical" : "Virtual"}</small></div><b>{audit.status === "in_progress" ? "Continue" : "Today"}</b></button>)}{!todayAudits.length ? <div className="fc-empty compact"><ClipboardCheck size={30} /><strong>No audit assigned today</strong><p>The smart programme avoids Sunday and approved Fleet Manager leave.</p></div> : null}</div>
              </article>
              <article className="fc-panel fc-priority-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Decision queue</span><h2>Payments needing attention</h2></div><button onClick={() => changeSection("approvals")} type="button">View all <ArrowRight size={15} /></button></div>
                <div className="fc-payment-list">
                  {pendingPayments.slice(0, 5).map((payment) => <button key={payment.id} onClick={() => { setSelectedPayment(payment); changeSection("approvals"); }} type="button"><span className="fc-request-icon"><CircleDollarSign size={17} /></span><div><strong>{payment.head}</strong><small>{payment.requestNo} · {payment.stationCode} · {payment.requestedBy}</small></div><span><b>{money(payment.amount)}</b><small>{date(payment.requestedAt, false)}</small></span><ArrowRight size={16} /></button>)}
                  {!pendingPayments.length ? <div className="fc-empty compact"><ShieldCheck size={32} /><strong>Approval queue is clear</strong><p>No vehicle payment is waiting with you.</p></div> : null}
                </div>
              </article>

              <article className="fc-panel fc-availability-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Fleet health</span><h2>Vehicle availability</h2></div><button onClick={() => changeSection("vehicles")} type="button">Manage <ArrowRight size={15} /></button></div>
                <div className="fc-ring-row"><div className="fc-ring" style={{ "--availability": `${availability * 3.6}deg` } as React.CSSProperties}><span><strong>{availability}%</strong><small>available</small></span></div><div className="fc-ring-legend"><p><i className="good" /><span>Active</span><b>{active}</b></p><p><i className="warn" /><span>Under service</span><b>{vehicles.filter((vehicle) => vehicle.status === "under_service").length}</b></p><p><i className="bad" /><span>Breakdown</span><b>{vehicles.filter((vehicle) => vehicle.status === "breakdown").length}</b></p><p><i className="neutral" /><span>Other</span><b>{vehicles.length - active - underService}</b></p></div></div>
                <div className="fc-progress"><span style={{ width: `${availability}%` }} /></div>
                <small className="fc-panel-foot">Target: 90% operational availability</small>
              </article>

              <article className="fc-panel fc-ad-hoc-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Live requests</span><h2>Ad Hoc usage</h2></div><button onClick={() => changeSection("adhoc")} type="button">Open usage <ArrowRight size={15} /></button></div>
                <div className="fc-activity-list">
                  {todayAdHoc.slice(0, 5).map((row) => <div key={`${row.id}-${row.date}`}><span>{row.stationCode}</span><div><strong>{row.requestType} · {row.reason}</strong><small>{row.reference} · {row.source}</small></div><b>{money(row.amount)}</b></div>)}
                  {!todayAdHoc.length ? <div className="fc-empty compact"><Activity size={30} /><strong>No ad-hoc request today</strong><p>Submitted van and driver requests will appear here.</p></div> : null}
                </div>
              </article>

              <article className="fc-panel fc-doc-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Compliance</span><h2>Documents to renew</h2></div><button onClick={() => changeSection("documents")} type="button">Open documents <ArrowRight size={15} /></button></div>
                <div className="fc-doc-list">
                  {attentionVehicles.slice(0, 5).map((vehicle) => <button key={vehicle.vehicleNo} onClick={() => { setSelectedVehicle(vehicle); changeSection("vehicles"); }} type="button"><span className={vehicle.nextDocumentDays != null && vehicle.nextDocumentDays < 0 ? "overdue" : "due"}><FileCheck2 size={17} /></span><div><strong>{vehicleDisplayName(vehicle)}</strong><FleetVehicleMeta vehicleNo={vehicle.vehicleNo} model={vehicle.model} stationCode={vehicle.stationCode}/><small>{documentMessage(vehicle)}</small></div><b>{vehicle.stationCode}</b></button>)}
                  {!attentionVehicles.length ? <div className="fc-empty compact"><FileCheck2 size={30} /><strong>Documents are in order</strong><p>No expiry falls within the next 30 days.</p></div> : null}
                </div>
              </article>
            </section>
          </> : null}

          {section === "vehicles" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Vehicle control</span><h1>{vehicleView === "live" ? "Live fleet status" : "Fleet registry"}</h1><p>{vehicleView === "live" ? "Station-grouped movement, availability and start-location control." : "Allocation, availability and document readiness across every station."}</p></div>{data.capabilities.canAddVehicles ? <button className="fc-button primary" onClick={() => setAddVehicle(true)} type="button"><Plus size={17} /> Add vehicle</button> : null}</div>
            <nav className="fc-view-switch" aria-label="Vehicle views"><button className={vehicleView === "live" ? "active" : ""} onClick={() => setVehicleView("live")} type="button"><Activity size={16} /> Live status</button><button className={vehicleView === "registry" ? "active" : ""} onClick={() => setVehicleView("registry")} type="button"><Truck size={16} /> Fleet registry</button></nav>
            <FleetScopeFilters {...scopeProps} onStatuses={setVehicleStatuses} statusOptions={uniqueOptions(vehicles.map((item) => item.status))} statuses={vehicleStatuses} /><div className="fc-inline-filter"><FleetMultiSelect allLabel="All deployment" label="Deployment" onChange={setVehicleDeployments} options={[{ value: "deployed", label: "Deployed" }, { value: "not_deployed", label: "Not deployed" }]} values={vehicleDeployments} /></div><div className="fc-source-quick-filters" role="group" aria-label="Vehicle source filters"><button type="button" aria-pressed={!vehicleOwnerships.length} className={!vehicleOwnerships.length?"active":""} onClick={()=>setVehicleOwnerships([])}>All <span>{sourceTotal}</span></button>{sources.filter(s=>s.isActive||sourceCounts.has(s.id)).map(source=><button key={source.id} type="button" title={sourceTitle(source)} aria-pressed={vehicleOwnerships.includes(source.id)} className={vehicleOwnerships.includes(source.id)?"active":""} onClick={()=>setVehicleOwnerships([source.id])}>{({OWN:"Own",ODCD:"ODCD",VAN:"Van Rented",VNV:"Van Vendor"} as Record<string,string>)[source.code]??source.name}<span>{sourceCounts.get(source.id)??0}</span></button>)}</div>
            {vehicleView === "live" ? <FleetVehicleLiveStatus onManage={setSelectedVehicle} vehicles={filteredVehicles} /> : <>
            <div className="fc-segment-cards"><article><small>Matching vehicles</small><strong>{filteredVehicles.length}</strong></article><article><small>Active</small><strong>{filteredVehicles.filter(v=>v.status==="active"&&v.deploymentStatus==="deployed").length}</strong></article><article><small>Under service</small><strong>{filteredVehicles.filter(v=>["under_service","breakdown"].includes(v.status)).length}</strong></article><article><small>Document attention</small><strong>{filteredVehicles.filter(v=>attentionVehicles.some(a=>a.id===v.id)).length}</strong></article></div>
            <div className="fc-table-panel">
              <div className="fc-table-toolbar"><span>{filteredVehicles.length} vehicles</span><div className="fc-toolbar-actions"><label>Sort <select onChange={(event) => setVehicleSort(event.target.value)} value={vehicleSort}><option value="vehicle">Vehicle number</option><option value="placement">Placement</option><option value="status">Status</option><option value="document">Document urgency</option></select></label><FleetExportButtons compact image report={{ title: "Fleet vehicle registry", subtitle: `As at ${data.today} · active filters applied`, fileName: `fleet-vehicles-${data.today}`, headers: ["Vehicle","Assigned station","Deployment","Current physical location","Location type","Source","Model","Fuel","Status","Next document","Expiry"], rows: filteredVehicles.map((item) => [item.vehicleNo,item.stationCode,item.deploymentStatus === "not_deployed" ? "Not deployed" : "Deployed",item.currentLocationLabel,item.currentLocationType,vehicleSourceTitle(item),item.model,item.fuelType,item.statusLabel,item.nextDocument,item.nextDocumentDate]) }} /></div></div>
              <div className="fc-table-scroll"><table><thead><tr><th>Vehicle</th><th>Assigned station</th><th>Deployment</th><th>Current location</th><th>Source</th><th>Fuel</th><th>Status</th><th>Next document</th><th>Action</th></tr></thead><tbody>
                {filteredVehicles.map((vehicle) => <tr key={vehicle.vehicleNo}><td><button className="fc-vehicle-link" onClick={() => setSelectedVehicle(vehicle)} type="button"><span><Truck size={17} /></span><div><strong>{vehicleDisplayName(vehicle)}</strong><small>{vehicleDisplayDetail(vehicle)}</small></div></button></td><td><b className="fc-station-chip">{vehicle.stationCode}</b></td><td><span className={`fc-deployment ${vehicle.deploymentStatus}`}>{vehicle.deploymentStatus === "not_deployed" ? "Not deployed" : "Deployed"}</span></td><td><strong>{vehicle.currentLocationLabel}</strong><small className="fc-cell-note">{vehicle.currentLocationType.replaceAll("_", " ")}{vehicle.currentLocationUpdatedAt ? ` · ${dateTime(vehicle.currentLocationUpdatedAt)}` : ""}</small></td><td>{vehicleSourceTitle(vehicle)}</td><td>{vehicle.fuelType}</td><td><span className={`fc-status ${statusTone(vehicle.status)}`}><i />{vehicle.statusLabel}</span></td><td><strong className={vehicle.nextDocumentDays != null && vehicle.nextDocumentDays <= 30 ? "fc-date-risk" : ""}>{vehicle.nextDocument ?? "Incomplete"}</strong><small className="fc-cell-note">{vehicle.nextDocumentDate ? date(vehicle.nextDocumentDate) : "No valid date"}</small></td><td><button className="fc-row-action" onClick={() => setSelectedVehicle(vehicle)} type="button">Manage <ArrowRight size={14} /></button></td></tr>)}
              </tbody></table></div>
              {!filteredVehicles.length ? <div className="fc-empty"><Search size={32} /><strong>No matching vehicle</strong><p>Change the search or vehicle placement filter.</p></div> : null}
            </div>
            </>}
          </section> : null}

          {section === "documents" ? <FleetDocumentsWorkspace data={data} vehicles={vehicles} initialVehicle={attentionTarget?.vehicle} initialDocumentType={attentionTarget?.documentType} /> : null}

          {section === "service" ? <FleetServiceWorkspace data={data} initialVehicle={attentionTarget?.vehicle} onChanged={() => router.refresh()} vehicles={vehicles} /> : null}

          {section === "audits" ? <section className="fc-section">
            <FleetScopeFilters {...scopeProps} />
            {!data.featureReady ? <div className="fc-setup-banner"><ListChecks size={20} /><div><strong>Fleet workflow migration is ready</strong><p>Apply the included migration to activate service history, audits, evidence and access management.</p></div></div> : null}
            <FleetAuditsWorkspace initialAuditId={auditToOpen} onOpened={() => setAuditToOpen(null)} audits={filteredAudits} data={data} onChanged={() => router.refresh()} vehicles={auditVehicles} />
          </section> : null}

          {section === "approvals" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Fleet-owned payments</span><h1>Vehicle payments</h1><p>Request replacement vans for company breakdowns and review vehicle expenses.</p></div>{data.capabilities.canRequestAdhoc ? <FleetBreakdownRequest today={data.today}/> : null}<FleetExportButtons report={{ title: "Vehicle payment report", subtitle: `As at ${data.today} · active filters applied`, fileName: `fleet-payments-${data.today}`, headers: ["Request", "Placement", "Head", "Amount", "Requested by", "Created", "Status"], rows: filteredPayments.map((payment) => [payment.requestNo, payment.stationCode, payment.head, payment.amount, payment.requestedBy, payment.requestedAt, payment.statusLabel]) }} /></div>
            <div className="fc-scope-filters fc-payment-filters"><FleetScopeFilters {...scopeProps} onStatuses={setPaymentStatuses} statusOptions={uniqueOptions(payments.map((item) => item.statusLabel))} statuses={paymentStatuses} /><FleetMultiSelect allLabel="All payment heads" label="Payment head" onChange={setPaymentHeads} options={uniqueOptions(payments.map((item) => item.head))} values={paymentHeads} /></div>
            <div className="fc-approval-layout">
              <div className="fc-panel fc-queue">
                <div className="fc-panel-head"><div><h2>Your queue</h2><p>{pendingPayments.length} requests awaiting action</p></div><label className="fc-queue-sort">Sort<select onChange={(event) => setPaymentSort(event.target.value)} value={paymentSort}><option value="date_desc">Latest</option><option value="amount_desc">Amount</option><option value="placement">Placement</option><option value="head">Payment head</option></select></label></div>
                <div className="fc-queue-list">{filteredPayments.map((payment) => <button className={selectedPayment?.id === payment.id ? "active" : ""} key={payment.id} onClick={() => setSelectedPayment(payment)} type="button"><span className={`fc-status ${statusTone(payment.statusLabel.toLowerCase())}`}><i />{payment.statusLabel}</span><strong>{payment.head}</strong><small>{payment.requestNo} · {payment.stationCode}</small><b>{money(payment.amount)}</b></button>)}</div>
                {!filteredPayments.length ? <div className="fc-empty"><CircleDollarSign size={32} /><strong>No matching payment</strong><p>Fleet Manager-owned vehicle payments will appear here. Ad-hoc vans stay in the visibility view.</p></div> : null}
              </div>
              <div className="fc-panel fc-payment-detail">
                {selectedPayment ? <>
                  <div className="fc-detail-top"><span className="fc-request-icon"><CircleDollarSign size={19} /></span><div><small>{selectedPayment.requestNo}</small><h2>{selectedPayment.head}</h2><p>{selectedPayment.stationCode} · requested by {selectedPayment.requestedBy}</p></div><strong>{money(selectedPayment.amount)}</strong></div>
                  <div className="fc-detail-grid"><div><small>Request date</small><strong>{date(selectedPayment.requestedAt)}</strong></div><div><small>Work date</small><strong>{date(selectedPayment.workDate)}</strong></div><div><small>Approval status</small><span className={`fc-status ${statusTone(selectedPayment.statusLabel.toLowerCase())}`}><i />{selectedPayment.statusLabel}</span></div><div><small>Station</small><strong>{selectedPayment.stationCode}</strong></div></div>
                  {paymentDetail?.replacement?<section className="fc-remarks"><strong>{paymentDetail.replacement.reason}</strong><p>{adhocVehicleLabel(paymentDetail.replacement)} · {paymentDetail.replacement.date}</p><FleetVehicleMeta vehicleNo={paymentDetail.replacement.number} model={paymentDetail.replacement.model} stationCode={selectedPayment.stationCode}/></section>:null}
                  {paymentDetail?.cost?<PaymentCostSummary {...paymentDetail.cost}/>:null}
                  {paymentDetail?.volumeDate?<PaymentVolumeContext date={paymentDetail.volumeDate} initialData={paymentDetail.volume??null} initialError={paymentDetail.volumeError}/>:null}
                  <section className="fc-remarks"><small>Station remarks</small><p>{selectedPayment.remarks}</p></section>
                  {paymentDetailError ? <div className="fc-detail-load-error">{paymentDetailError}</div> : null}
                  <div className="fc-payment-support-grid">
                    <section className="fc-evidence-panel">
                      <div className="fc-mini-head"><span><FileText size={15} /></span><div><strong>Attachments & details</strong><small>{paymentDetailLoading ? "Loading evidence…" : `${paymentDetail?.attachments.length ?? 0} files attached`}</small></div></div>
                      {paymentDetailLoading ? <div className="fc-detail-loading">Loading request evidence…</div> : <>
                        <div className="fc-attachment-list">{paymentDetail?.attachments.map((attachment) => <a href={`/api/payments/requests/attachment?answer_id=${encodeURIComponent(attachment.id)}`} key={attachment.id} rel="noreferrer" target="_blank"><span><FileText size={14} /></span><div><strong>{attachment.fileName}</strong><small>{attachment.label}</small></div><Eye size={15} /><b>View</b></a>)}{!paymentDetail?.attachments.length ? <p>No attachment was uploaded with this request.</p> : null}</div>
                        {paymentDetail?.answers.length ? <div className="fc-answer-list">{paymentDetail.answers.map((answer) => <p key={answer.id}><span>{answer.label}</span><strong>{answer.value}</strong></p>)}</div> : null}
                      </>}
                    </section>
                    <section className="fc-approval-flow">
                      <div className="fc-mini-head"><span><GitBranch size={15} /></span><div><strong>Approval flow</strong><small>{paymentDetail?.currentStage ? `Pending with ${paymentDetail.currentStage}` : "Complete decision history"}</small></div></div>
                      {paymentDetailLoading ? <div className="fc-detail-loading">Loading approval trail…</div> : <div className="fc-flow-list">{paymentDetail?.history.map((entry, index) => <article key={entry.id}><i className={entry.action.toLowerCase()} /><div><header><strong>{actionLabel(entry.action)}</strong><time>{dateTime(entry.createdAt)}</time></header><p>{entry.actor}<span>{entry.role}</span></p>{entry.comments ? <small>{entry.comments}</small> : null}</div>{index < (paymentDetail?.history.length ?? 0) - 1 ? <b /> : null}</article>)}{!paymentDetail?.history.length ? <p className="fc-flow-empty">No approval action has been recorded yet.</p> : null}{paymentDetail?.currentStage ? <article className="current"><i /><div><header><strong>Current approval</strong><time>Now</time></header><p>{paymentDetail.currentStage}</p><small>Awaiting decision</small></div></article> : null}</div>}
                    </section>
                  </div>
                  {selectedPayment.canApprove ? <PaymentApprovalActionForm approveAction={approveAction} endpoint="/api/fleet-control/payment-action" onComplete={finishPaymentAction} rejectAction={rejectAction} requestId={selectedPayment.id} requestRemarks={null} returnAction={returnAction} status="pending" /> : <div className="fc-readonly-note"><ShieldCheck size={18} /><span><strong>Decision recorded</strong><small>This request is no longer waiting for your approval. The trail above has updated without reloading the page.</small></span></div>}
                </> : <div className="fc-empty detail"><CircleDollarSign size={40} /><strong>Select a payment request</strong><p>Review the request, amount, station remarks and current approval stage.</p></div>}
              </div>
            </div>
          </section> : null}

          {section === "tracking" ? <section className="fc-section"><FleetTrackingWorkspace data={{ ...data, vehicles }} exceptionEntry={exceptionEntry} onReviewed={(review)=>{setReviewUpdates(previous=>[...previous,review]);router.refresh();}} /></section> : null}
          {section === "fuel" ? <section className="fc-section"><DailyFleetReportView focus="fuel" stationOptions={data.stationOptions} /></section> : null}

          {section === "adhoc" ? <section className="fc-section"><FleetAdHocCapacity rows={data.adHocRows} stationOptions={data.stationOptions} today={data.today} /></section> : null}

          {section === "reports" ? <section className="fc-section"><FleetReportsWorkspace data={{ ...data, vehicles, payments, movements }} /></section> : null}

          {section === "settings" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Administration</span><h1>{settingsTab === "system_logs" ? "System Logs" : settingsTab === "auto_mail" ? "Auto Mail Scheduler" : "Settings"}</h1><p>{settingsTab === "auto_mail" ? "Schedule and control the station-scoped DropX Daily Fleet Update." : "Control Fleet policy, automated reminders and connected vehicle data."}</p></div>{settingsTab === "auto_mail" ? <button className="fc-button secondary" onClick={() => setMailPreviewOpen(true)} type="button"><Eye size={16} /> Preview sample mail</button> : null}</div>
            {settingsTab === "system_logs" ? <FleetSystemLogs today={data.today}/> : null}
            {settingsTab === "general" ? <div className="fc-settings-grid"><article className="fc-panel fc-settings-card"><div className="fc-panel-head"><div><span className="fc-eyebrow">Fleet policy</span><h2>Audit and service rules</h2></div><Settings size={20} /></div><form className="fc-settings-form" onSubmit={submitSettings}><label><span>Routine audit cadence</span><div><input defaultValue={data.settings.defaultAuditCadenceDays} min="1" name="defaultAuditCadenceDays" type="number" /><small>days</small></div></label><label><span>Document warning</span><div><input defaultValue={data.settings.documentWarningDays} min="1" name="documentWarningDays" type="number" /><small>days</small></div></label><label><span>Service warning</span><div><input defaultValue={data.settings.serviceWarningDays} min="1" name="serviceWarningDays" type="number" /><small>days</small></div></label><label className="fc-toggle"><input defaultChecked={data.settings.autoSuggestAudits} name="autoSuggestAudits" type="checkbox" /><span>System audit suggestions</span></label><label className="fc-toggle"><input defaultChecked={data.settings.auditVideoRequired} name="auditVideoRequired" type="checkbox" /><span>Require walk-around video</span></label><label className="fc-toggle"><input defaultChecked={data.settings.auditEmailEnabled} name="auditEmailEnabled" type="checkbox" /><span>Email audit findings</span></label><label className="fc-toggle"><input defaultChecked={data.settings.breakdownVehicleLinkRequired} name="breakdownVehicleLinkRequired" type="checkbox" /><span>Activate breakdown-to-vehicle link</span><small>Keep off until the ad-hoc request form is released.</small></label>{data.capabilities.canManageSettings ? <button className="fc-button primary" disabled={savingAction === "settings.update"} type="submit">Save policy</button> : null}</form></article>
              <article className="fc-panel fc-settings-card"><div className="fc-panel-head"><div><span className="fc-eyebrow">Integrations</span><h2>Connected vehicle data</h2></div><PlugZap size={20} /></div><div className="fc-integration-list">{data.integrations.map((integration) => <div key={integration.key}><span className={`fc-integration-mark ${integration.key}`}>{integration.key === "paytap" ? "P" : "W"}</span><div><strong>{integration.name}</strong><p>{integration.purpose}</p><small>{integration.detail}{integration.lastSyncAt ? ` · Last sync ${date(integration.lastSyncAt)}` : ""}</small></div><b className={integration.status}>{integration.status.replaceAll("_", " ")}</b></div>)}</div></article>
              <article className="fc-panel fc-settings-card fc-audit-policy-card"><div className="fc-panel-head"><div><span className="fc-eyebrow">Vehicle audit programme</span><h2>Schedule and audit email</h2><p>These values drive the automatic planner and the completion email. They are saved configuration.</p></div><ClipboardCheck size={20} /></div><form className="fc-settings-form" onSubmit={submitAuditProgrammeSettings}><label className="fc-toggle"><input defaultChecked={data.settings.auditProgramme.enabled} name="enabled" type="checkbox" /><span>Automatic monthly scheduling</span></label><label><span>Physical audits / vehicle / month</span><input defaultValue={1} max="1" min="1" name="physicalPerMonth" readOnly type="number" /></label><label><span>Virtual audits / vehicle / month</span><input defaultValue={1} max="1" min="1" name="virtualPerMonth" readOnly type="number" /></label><label><span>Maximum physical vehicles per day</span><input defaultValue={data.settings.auditProgramme.maxPhysicalPerDay} max="20" min="1" name="maxPhysicalPerDay" type="number" /></label><label><span>Minimum days between both audits</span><input defaultValue={data.settings.auditProgramme.minGapDays} min="1" max="21" name="minGapDays" type="number" /></label><label><span>Physical stations per day</span><input defaultValue={data.settings.auditProgramme.maxPhysicalStationsPerDay} min="1" max="5" name="maxPhysicalStationsPerDay" type="number" /></label><label><span>Nearby station distance (km)</span><input defaultValue={data.settings.auditProgramme.nearbyStationKm} min="1" max="100" name="nearbyStationKm" type="number" /><small>Straight-line distance between stations. Whole stations stay together; raise capacity if a station has more vehicles.</small></label><label><span>Virtual capacity per day</span><input defaultValue={data.settings.auditProgramme.maxVirtualPerDay} max="30" min="1" name="maxVirtualPerDay" type="number" /></label><div className="fc-weekday-config"><span>Days with no audit</span>{[[0,"Sun"],[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"]].map(([day,label]) => <label key={day}><input defaultChecked={data.settings.auditProgramme.excludedWeekdays.includes(Number(day))} name="excludedWeekdays" type="checkbox" value={day} />{label}</label>)}</div><label className="fc-toggle"><input defaultChecked={data.settings.auditProgramme.autoMoveForLeave} name="autoMoveForLeave" type="checkbox" /><span>Move around approved Fleet Manager leave</span></label><label><span>Audit email title</span><input defaultValue={data.settings.auditProgramme.emailTitle} name="emailTitle" required /></label><label><span>Subject prefix</span><input defaultValue={data.settings.auditProgramme.emailSubjectPrefix} name="emailSubjectPrefix" required /></label><label className="fc-toggle"><input defaultChecked={data.settings.auditProgramme.includeEvidence} name="includeEvidence" type="checkbox" /><span>Include clickable evidence attachments</span></label><div className="fc-audit-color-row"><label><span>Header</span><input defaultValue={data.settings.auditProgramme.primaryColor} name="primaryColor" type="color" /></label><label><span>Accent</span><input defaultValue={data.settings.auditProgramme.accentColor} name="accentColor" type="color" /></label><label><span>Alert</span><input defaultValue={data.settings.auditProgramme.alertColor} name="alertColor" type="color" /></label></div>{data.capabilities.canManageSettings ? <button className="fc-button primary" disabled={savingAction === "settings.update-audit-programme"} type="submit">Save audit programme</button> : null}</form></article>
              <article className="fc-panel fc-settings-card fc-account-card"><div className="fc-panel-head"><div><span className="fc-eyebrow">Account</span><h2>Signed in as {data.operator.name}</h2><p>End this Fleet session on the current device.</p></div><LogOut size={20} /></div><form action={signOutAction}><button className="fc-button danger" type="submit"><LogOut size={16} /> Sign out</button></form></article>
            </div> : null}
            {settingsTab === "auto_mail" ? <div className="fc-mail-settings">
              <article className="fc-panel fc-mail-editor"><div className="fc-panel-head"><div><span className="fc-eyebrow">Daily dispatch</span><h2>{data.settings.dailyStatusEmailConfig.title}</h2><p>Edit the schedule, email copy, sections, colors, audience sources, exclusions and threading.</p></div><span className={`fc-mail-state ${data.settings.dailyStatusEmailEnabled ? "active" : "held"}`}>{data.settings.dailyStatusEmailEnabled ? <><Play size={13} /> Active</> : <><Pause size={13} /> On hold</>}</span></div><form className="fc-mail-config-form" onSubmit={submitMailSettings}>
                <fieldset><legend>Schedule</legend><label><span>Send every day at</span><div className="fc-input-suffix"><input defaultValue={data.settings.dailyStatusSendTime || "20:00"} name="dailyStatusSendTime" required type="time" /><small>IST</small></div></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailEnabled} name="dailyStatusEmailEnabled" type="checkbox" /><span>Enable automatic mail</span><small>Hold or resume future dispatches without removing recipients.</small></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusOnlyAffected} name="dailyStatusOnlyAffected" type="checkbox" /><span>Send only when attention exists</span><small>Each recipient receives the full status for their mapped stations when at least one needs attention.</small></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.monthlyThread} name="monthlyThread" type="checkbox" /><span>One monthly thread</span><small>The first delivery starts the month’s thread. Every daily 8:00 PM update replies to it; the next month starts a new thread.</small></label></fieldset>
                <fieldset><legend>Email copy</legend><label><span>Email title</span><input defaultValue={data.settings.dailyStatusEmailConfig.title} name="title" required /></label><label><span>Subject prefix</span><input defaultValue={data.settings.dailyStatusEmailConfig.subjectPrefix} name="subjectPrefix" required /></label><label><span>Header label</span><input defaultValue={data.settings.dailyStatusEmailConfig.headerLabel} name="headerLabel" required /></label><label className="wide"><span>Introduction</span><textarea defaultValue={data.settings.dailyStatusEmailConfig.intro} name="intro" required rows={2} /></label><label className="wide"><span>Footer</span><textarea defaultValue={data.settings.dailyStatusEmailConfig.footer} name="footer" required rows={2} /></label></fieldset>
                <fieldset><legend>Content</legend><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.includeSummary} name="includeSummary" type="checkbox" /><span>Headline totals</span></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.includeStationTable} name="includeStationTable" type="checkbox" /><span>Station status table</span></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.includeNonOperationalTable} name="includeNonOperationalTable" type="checkbox" /><span>Non-operational actions</span></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.includeAdHoc} name="includeAdHoc" type="checkbox" /><span>Ad hoc Van + Driver summary</span></label></fieldset>
                <fieldset><legend>Audience and exclusions</legend><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.includeMappedOperations} name="includeMappedOperations" type="checkbox" /><span>Station-mapped Operations users</span></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.includeAllLocationOperations} name="includeAllLocationOperations" type="checkbox" /><span>All-location Operations leadership</span></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.includeStationMailboxes} name="includeStationMailboxes" type="checkbox" /><span>Station manager mailboxes</span></label><label className="fc-toggle"><input defaultChecked={data.settings.dailyStatusEmailConfig.excludeAmazonNow} name="excludeAmazonNow" type="checkbox" /><span>Exclude Amazon Now locations</span></label><label className="wide"><span>Other excluded station codes</span><input defaultValue={data.settings.dailyStatusEmailConfig.excludedStationCodes.join(", ")} name="excludedStationCodes" placeholder="Example: ABCD, EFGH" /></label></fieldset>
                <fieldset className="fc-mail-colors"><legend>Colors</legend><label><span>Header</span><input defaultValue={data.settings.dailyStatusEmailConfig.primaryColor} name="primaryColor" type="color" /></label><label><span>Accent</span><input defaultValue={data.settings.dailyStatusEmailConfig.accentColor} name="accentColor" type="color" /></label><label><span>Alert</span><input defaultValue={data.settings.dailyStatusEmailConfig.alertColor} name="alertColor" type="color" /></label></fieldset>
                <div className="fc-mail-form-actions"><button className="fc-button secondary" onClick={() => setMailPreviewOpen(true)} type="button"><Eye size={15} /> Preview current saved design</button>{data.capabilities.canManageSettings ? <button className="fc-button primary" disabled={savingAction === "settings.update-mail"} type="submit">{savingAction === "settings.update-mail" ? "Saving…" : "Save all email settings"}</button> : null}</div>
              </form></article>
              <article className="fc-panel fc-status-recipients"><div className="fc-panel-head"><div><span className="fc-eyebrow">Effective delivery audience</span><h2>Who receives which stations</h2><p>This is the resolved audience from People mappings, station mailboxes and active manual recipients. Every address receives a separate station-scoped email.</p></div><Mail size={20} /></div><div className="fc-recipient-list">{data.resolvedStatusRecipients.map((row) => <div key={row.email}><span>{row.name.slice(0,1).toUpperCase()}</span><div><strong>{row.name}</strong><small>{row.email}</small><small>{row.stationCodes.join(", ")} · {row.sources.map((source) => source === "people" ? "People mapping" : source === "station" ? "Station mailbox" : "Manual").join(" + ")}</small></div></div>)}{!data.resolvedStatusRecipients.length ? <p className="fc-recipient-empty">No effective recipients are currently resolved. The scheduler will remain silent until an active recipient has at least one eligible station.</p> : null}</div></article>
              <article className="fc-panel fc-status-recipients"><div className="fc-panel-head"><div><span className="fc-eyebrow">Additional distribution</span><h2>Manual recipients</h2><p>Add, edit, hold, resume or delete recipients. Leave station codes blank for all report stations.</p></div><Users size={20} /></div><div className="fc-recipient-list">{data.statusRecipients.map((row) => <div className={row.isActive ? "" : "held"} key={row.id}><span>{row.name.slice(0,1).toUpperCase()}</span><div><strong>{row.name}{!row.isActive ? " · On hold" : ""}</strong><small>{row.email} · {row.stationCodes.length ? row.stationCodes.join(", ") : "All report stations"}</small></div>{data.capabilities.canManageSettings ? <div className="fc-recipient-actions"><button aria-label={`Edit ${row.name}`} onClick={() => setRecipientEditor(row)} title="Edit" type="button"><Pencil size={14} /></button><button aria-label={`${row.isActive ? "Hold" : "Resume"} ${row.name}`} onClick={() => toggleStatusRecipient(row.id, !row.isActive)} title={row.isActive ? "Hold" : "Resume"} type="button">{row.isActive ? <Pause size={14} /> : <Play size={14} />}</button><button aria-label={`Delete ${row.name}`} className="danger" onClick={() => deleteStatusRecipient(row.id, row.name)} title="Delete" type="button"><Trash2 size={14} /></button></div> : null}</div>)}{!data.statusRecipients.length ? <p className="fc-recipient-empty">No manual recipients. Enable an audience source above or add a recipient here.</p> : null}</div>{data.capabilities.canManageSettings ? <form className="fc-recipient-form" key={recipientEditor?.id ?? "new"} onSubmit={submitStatusRecipient}><input defaultValue={recipientEditor?.name ?? ""} name="name" placeholder="Name" required /><input defaultValue={recipientEditor?.email ?? ""} name="email" placeholder="Email" required type="email" /><input defaultValue={recipientEditor?.stationCodes.join(", ") ?? ""} name="stationCodes" placeholder="Station codes, comma separated · blank = all" /><button className="fc-button secondary" disabled={savingAction === "status-recipient.upsert"} type="submit">{recipientEditor ? <><Pencil size={14} /> Save recipient</> : <><Plus size={14} /> Add recipient</>}</button>{recipientEditor ? <button className="fc-button ghost" onClick={() => setRecipientEditor(null)} type="button">Cancel</button> : null}</form> : null}</article>
            </div> : null}
            {mailPreviewOpen ? <div className="fc-modal-backdrop"><section className="fc-modal wide fc-mail-preview"><button aria-label="Close preview" className="fc-modal-close" onClick={() => setMailPreviewOpen(false)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Mail size={22} /></span><div><small>Email preview · live fleet data</small><h2>{data.settings.dailyStatusEmailConfig.title}</h2><p>Actual saved design · scheduled for {data.settings.dailyStatusSendTime} IST.</p></div></div><label>Region <select aria-label="Email preview region" value={selectedMailRegion} onChange={event => setMailRegion(event.target.value)}>{mailRegions.map(region => <option key={region}>{region}</option>)}</select></label><iframe srcDoc={dailyMailPreview.html} title={`${data.settings.dailyStatusEmailConfig.title} sample`} /></section></div> : null}
          </section> : null}

          {section === "masters" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Configuration</span><h1>Masters</h1><p>Maintain reusable vehicle rules and operational master data without changing application code.</p></div></div>
            {masterTab === "vehicle_audit" ? <div className="fc-settings-grid lower"><article className="fc-panel fc-master-audit"><div className="fc-panel-head"><div><span className="fc-eyebrow">Vehicle Audit</span><h2>Audit checklist controls</h2><p>{data.checklistItems.length} active controls · edit or remove any control</p></div>{data.capabilities.canManageSettings ? <button onClick={() => openChecklist()} type="button">Add control <Plus size={14} /></button> : null}</div><div className="fc-master-list editable">{data.checklistItems.map((item) => <div key={item.id}><span>{item.sortOrder}</span><div><strong>{item.label}</strong><small>{item.category} · {item.responseConfig?.kind || item.responseType.replaceAll("_", " ")} · {item.failureSeverity} · {item.auditMode === "both" ? "video + physical" : `${item.auditMode} only`}</small><small className="fc-evidence-rules" style={item.responseConfig ? {display:"none"} : undefined}><b>Compliant:</b> {item.passMinEvidence ? `${item.passMinEvidence} ${item.passEvidenceType}` : "no attachment"} <b>Non-compliant:</b> {item.failMinEvidence ? `${item.failMinEvidence} ${item.failEvidenceType}` : "no attachment"} · {item.failRemarksRequired ? "remark required" : "remark optional"}</small></div><b>{item.isRequired ? "Required" : "Optional"}</b>{data.capabilities.canManageSettings ? <div className="fc-master-actions"><button aria-label={`Edit ${item.label}`} onClick={() => openChecklist(item)} type="button"><Pencil size={14} /></button><button aria-label={`Remove ${item.label}`} className="danger" onClick={() => removeChecklist(item)} type="button"><Trash2 size={14} /></button></div> : null}</div>)}{!data.checklistItems.length ? <div className="fc-empty compact"><ListChecks size={30} /><strong>No audit controls configured</strong><p>Add the first control to make the audit executable.</p></div> : null}</div></article><article className="fc-panel"><div className="fc-panel-head"><div><span className="fc-eyebrow">Vehicle Audit</span><h2>Checklist templates</h2><p>{data.auditTemplates.length} reusable audit formats</p></div>{data.capabilities.canManageSettings ? <button onClick={() => setAuditTemplateEditor("new")} type="button">Add template <Plus size={14} /></button> : null}</div><div className="fc-master-list editable">{data.auditTemplates.map((template, index) => <div key={template.id}><span>{index + 1}</span><div><strong>{template.name}</strong><small>{template.description || "Vehicle audit template"} · every {template.cadenceDays} days · {template.itemCount} checks</small></div><b>{template.isDefault ? "Default" : "Active"}</b>{data.capabilities.canManageSettings ? <div className="fc-master-actions"><button aria-label={`Edit ${template.name}`} onClick={() => setAuditTemplateEditor(template)} type="button"><Pencil size={14} /></button><button aria-label={`Remove ${template.name}`} className="danger" disabled={template.isDefault} onClick={() => removeAuditTemplate(template)} type="button"><Trash2 size={14} /></button></div> : null}</div>)}{!data.auditTemplates.length ? <div className="fc-empty compact"><ListChecks size={30} /><strong>No audit template configured</strong><p>Create a routine audit template before adding checks.</p></div> : null}</div></article></div> : null}
            {masterTab === "vehicle_documents" ? <article className="fc-panel"><div className="fc-panel-head"><div><span className="fc-eyebrow">Vehicle Documents</span><h2>Document validity master</h2><p>Add, edit or remove document rules, expiry behavior and reminder timing.</p></div>{data.capabilities.canManageSettings ? <button onClick={() => setDocumentTypeEditor("new")} type="button">Add document <Plus size={14} /></button> : null}</div><div className="fc-master-list editable">{data.documentTypes.map((type, index) => <div key={type.value}><span>{index + 1}</span><div><strong>{type.label}</strong><small>{type.value} · Reminder {type.reminderDays} days before · {type.expiryMode === "required" ? "expiry required" : type.expiryMode === "linked_fitness" ? "validity follows Fitness" : "expiry optional"}</small></div><b>{type.expiryMode.replaceAll("_", " ")}</b>{data.capabilities.canManageSettings ? <div className="fc-master-actions"><button aria-label={`Edit ${type.label}`} onClick={() => setDocumentTypeEditor(type)} type="button"><Pencil size={14} /></button><button aria-label={`Remove ${type.label}`} className="danger" disabled={!type.id} onClick={() => removeDocumentType(type)} type="button"><Trash2 size={14} /></button></div> : null}</div>)}</div></article> : null}
            {masterTab === "vehicle_statuses" ? <FleetStatusMaster statuses={data.vehicleStatuses} canEdit={data.capabilities.canManageSettings} onEdit={item=>setStatusMasterEditor({kind:"status",item})} onRemove={removeVehicleStatus} onAddReason={status=>setStatusMasterEditor({kind:"reason",status,item:null})} onEditReason={(status,item)=>setStatusMasterEditor({kind:"reason",status,item})} onRemoveReason={removeVehicleStatusReason}/> : null}
            {masterTab === "vehicle_sources" ? <FleetSourceMaster sources={sources} designations={data.sourceDesignations??[]} canEdit={data.capabilities.canManageSettings} onSave={values=>fleetAction("vehicle-source.save",values)}/> : null}
          </section> : null}
        </div>
      </section>

      {selectedVehicle ? <div className="fc-modal-backdrop" role="presentation"><section aria-label={`Manage ${vehicleDisplayName(selectedVehicle)}`} className="fc-modal wide fc-vehicle-manage"><button aria-label="Close" className="fc-modal-close" onClick={() => setSelectedVehicle(null)} type="button"><X size={19} /></button>
        <div className="fc-modal-title fc-manage-title"><span className="fc-vehicle-big"><Truck size={25} /></span><div><small>{selectedVehicle.fuelType}</small><h2>{vehicleDisplayName(selectedVehicle)}</h2><p>{vehicleDisplayDetail(selectedVehicle)}</p></div><button className="fc-lifecycle-open" onClick={() => { setLifecycleVehicle(selectedVehicle); setSelectedVehicle(null); }} type="button"><BarChart3 size={15} /> Open vehicle lifecycle</button></div>
        <div className="fc-status-control scalable crisp"><div className="fc-status-control-head"><div><small>Availability update</small><strong>{selectedStatusDefinition?.helper || selectedVehicle.statusLabel}</strong></div><span className={`fc-status ${selectedStatusDefinition?.tone ?? statusTone(selectedVehicle.status)}`}><i />{selectedStatusDefinition?.label ?? selectedVehicle.statusLabel}</span></div><div className="fc-availability-statuses" role="radiogroup" aria-label="Vehicle status">{vehicleStatusOptions.filter(option=>sourceApplies(option,ownershipDraft)).map((option) => <button aria-checked={statusDraft === option.key} className={`${option.tone} ${statusDraft === option.key ? "active" : ""}`} disabled={!data.capabilities.canEditVehicles} key={option.key} onClick={() => { setStatusDraft(option.key); setStatusReasonId(option.key === selectedVehicle.status ? selectedVehicle.statusReasonId ?? "" : ""); if (option.isOperational) { setExpectedOperationalDate(""); setStatusComment(""); } }} role="radio" type="button"><i />{option.label}</button>)}</div><div className="fc-status-update compact"><label><span>Vehicle source</span><select disabled={!data.capabilities.canEditVehicles} value={sourceDraft} onChange={event=>{setSourceDraft(event.target.value);setStatusDraft("active");setStatusReasonId("");}}>{sources.filter(s=>s.isActive||s.id===selectedVehicle.sourceId).map(s=><option key={s.id} value={s.id}>{sourceTitle(s)}{!s.isActive?" (disabled)":""}</option>)}</select></label>{!selectedStatusDefinition?.isOperational ? <>{selectedStatusDefinition?.requiresReason || selectedStatusDefinition?.reasons.some(r=>r.isActive) ? <label><span>Reason{selectedStatusDefinition?.requiresReason ? " *" : ""}</span><select disabled={!data.capabilities.canEditVehicles} onChange={(event) => setStatusReasonId(event.target.value)} required={selectedStatusDefinition?.requiresReason} value={statusReasonId}><option value="">Select reason</option>{selectedStatusDefinition?.reasons.filter((reason) => reason.isActive).map((reason) => <option key={reason.id} value={reason.id}>{reason.label}</option>)}</select></label> : null}<label><span>{statusDraft === "on_leave" ? "Leave from" : "Out of service from"}</span><input disabled={!data.capabilities.canEditVehicles} max={data.today} onChange={(event) => setStatusSince(event.target.value)} type="date" value={statusSince} /></label><label><span>Expected return{selectedStatusDefinition?.requiresExpectedDate ? " *" : ""}</span><input disabled={!data.capabilities.canEditVehicles} min={statusSince || data.today} onChange={(event) => setExpectedOperationalDate(event.target.value)} required={selectedStatusDefinition?.requiresExpectedDate} type="date" value={expectedOperationalDate} /></label><label className="comment"><span>Latest comment</span><input disabled={!data.capabilities.canEditVehicles} onChange={(event) => setStatusComment(event.target.value)} placeholder="Optional short update" value={statusComment} /></label></> : null}{data.capabilities.canEditVehicles ? <button className="fc-button primary" disabled={!statusDraft || Boolean(selectedStatusDefinition?.requiresReason && !statusReasonId) || Boolean(selectedStatusDefinition?.requiresExpectedDate && !expectedOperationalDate) || (statusDraft === selectedVehicle.status && sourceDraft === selectedVehicle.sourceId && statusReasonId === (selectedVehicle.statusReasonId ?? "") && statusComment === selectedVehicle.statusComment && expectedOperationalDate === (selectedVehicle.expectedOperationalDate ?? "")) || savingVehicle === selectedVehicle.vehicleNo} onClick={() => updateVehicleStatus(selectedVehicle)} type="button">{savingVehicle === selectedVehicle.vehicleNo ? "Saving…" : selectedStatusDefinition?.isOperational ? "Mark operational" : "Update"}</button> : null}</div></div>
        <FleetVehicleContactEditor key={`${selectedVehicle.id}-${selectedVehicle.ownershipType}`} vehicle={selectedVehicle} canEdit={data.capabilities.canEditVehicles} onSaved={values=>{setVehicles(current=>current.map(v=>v.id===selectedVehicle.id?{...v,...values}:v));setSelectedVehicle(current=>current?{...current,...values}:current);router.refresh();}} />
        <div className="fc-manage-grid">
          <section className="fc-manage-card"><div className="fc-manage-card-head"><span><MapPin size={17} /></span><div><strong>Deployment & location</strong><small>Keep assignment separate from where the vehicle is now</small></div></div><form className="fc-placement-form expanded" onSubmit={updateVehiclePlacement}><div className="fc-placement-grid"><label><span>Deployment</span><select disabled={!data.capabilities.canEditVehicles} onChange={(event) => setDeploymentDraft(event.target.value as FleetControlVehicle["deploymentStatus"])} value={deploymentDraft}><option value="deployed">Deployed</option><option value="not_deployed">Not deployed</option></select></label><label><span>Assigned station</span><SearchableSelect disabled={!data.capabilities.canEditVehicles} name="station_code" onValueChange={setPlacementStation} options={data.stationOptions.map((station) => ({ value: station.code, label: station.code, helper: `${station.name} · ${station.cluster} · ${station.region}` }))} placeholder="Search station code or name" required value={placementStation} /></label><label><span>Current location type</span><select disabled={!data.capabilities.canEditVehicles} onChange={(event) => setCurrentLocationTypeDraft(event.target.value as FleetControlVehicle["currentLocationType"])} value={currentLocationTypeDraft}><option value="station">Station</option><option value="ho">HO / office</option><option value="workshop">Workshop</option><option value="in_transit">In transit</option><option value="other">Other location</option></select></label><label><span>Current physical location *</span><input disabled={!data.capabilities.canEditVehicles} list="fleet-current-locations" onChange={(event) => setCurrentLocationDraft(event.target.value)} placeholder="Station, HO, workshop or any place" required value={currentLocationDraft} /><datalist id="fleet-current-locations">{data.stationOptions.map((station) => <option key={station.code} value={`${station.code} · ${station.name}`} />)}</datalist></label></div><label><span>Update reason</span><input disabled={!data.capabilities.canEditVehicles} onChange={(event) => setPlacementReason(event.target.value)} placeholder="Not deployed, at HO, workshop visit, route reallocation…" value={placementReason} /></label>{data.capabilities.canEditVehicles ? <button className="fc-button primary" disabled={!placementStation || !currentLocationDraft.trim() || (placementStation === selectedVehicle.stationCode && deploymentDraft === selectedVehicle.deploymentStatus && currentLocationTypeDraft === selectedVehicle.currentLocationType && currentLocationDraft.trim() === (selectedVehicle.currentLocationLabel || selectedVehicle.stationCode)) || savingVehicle === selectedVehicle.vehicleNo} type="submit">{savingVehicle === selectedVehicle.vehicleNo ? "Saving…" : "Update placement"}</button> : null}</form></section>
          <section className="fc-manage-card"><div className="fc-manage-card-head"><span><FileCheck2 size={17} /></span><div><strong>Document compliance</strong><small>Files and time-bound validity</small></div><button onClick={() => { setSelectedVehicle(null); changeSection("documents"); }} type="button">Open all <ArrowRight size={14} /></button></div><div className="fc-manage-docs">{data.documentTypes.filter(type=>documentApplies(type,selectedVehicle)).map((type) => { const stored = data.documents.find((document) => document.vehicleNo === selectedVehicle.vehicleNo && document.documentType === type.value); const key = ({ FLEET_REGISTRATION: "registrationExpiry", FLEET_INSURANCE: "insuranceExpiry", FLEET_PUC: "pucExpiry", FLEET_FITNESS: "fitnessExpiry", FLEET_TAX: "taxExpiry" } as Record<string, keyof FleetControlVehicle>)[type.value]; const expiry = stored?.expiryDate ?? (key ? selectedVehicle[key] as string | null : null); const validDate = Boolean(expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry.slice(0, 10))); const detail = type.expiryMode === "linked_fitness" && selectedVehicle.ownershipType === "own" && !validDate ? "Validity follows Fitness certificate" : validDate ? date(expiry) : type.expiryMode === "required" ? "Validity date required" : "No validity date required"; return <div key={type.value}><span className={stored ? "ready" : "missing"}>{stored ? <Check size={12} /> : <AlertTriangle size={12} />}</span><div><strong>{type.label}</strong><small>{stored ? detail : "Document file missing"}</small></div>{stored?.viewUrl ? <a aria-label={`View ${type.label}`} href={stored.viewUrl} rel="noreferrer" target="_blank"><Eye size={14} /></a> : null}</div>; })}</div></section>
        </div>
        <FleetVehicleRentEditor key={selectedVehicle.id} vehicle={selectedVehicle} canEdit={data.capabilities.canEditVehicles} onSaved={(values) => { setVehicles((current) => current.map((vehicle) => vehicle.id === selectedVehicle.id ? { ...vehicle, ...values } : vehicle)); setSelectedVehicle((current) => current ? { ...current, ...values } : current); router.refresh(); }} />
        <section className="fc-placement-history"><button aria-expanded={placementHistoryOpen} onClick={() => setPlacementHistoryOpen((value) => !value)} type="button"><span><History size={17} /><div><strong>Deployment & location history</strong><small>Assigned station, physical location and each change</small></div></span><b>{movements.filter((item) => item.vehicleId === selectedVehicle.id || item.vehicleNo === selectedVehicle.vehicleNo).length} updates</b></button>{placementHistoryOpen ? <div className="fc-placement-timeline">{movements.filter((item) => item.vehicleId === selectedVehicle.id || item.vehicleNo === selectedVehicle.vehicleNo).map((item) => <article key={item.id}><i /><div><header><strong>{item.fromStation} <ArrowRight size={12} /> {item.toStation}</strong><time>{dateTime(item.movedAt)}</time></header><p>{item.reason}</p><small>Updated by {item.movedBy}</small></div></article>)}{!movements.some((item) => item.vehicleId === selectedVehicle.id || item.vehicleNo === selectedVehicle.vehicleNo) ? <article><i /><div><header><strong>{selectedVehicle.deploymentStatus === "not_deployed" ? "Not deployed" : "Deployed"} · {selectedVehicle.currentLocationLabel}</strong><time>{dateTime(selectedVehicle.currentLocationUpdatedAt || selectedVehicle.createdAt)}</time></header><p>Assigned station · {selectedVehicle.stationCode}</p><small>No earlier location update has been recorded in Fleet.</small></div></article> : null}</div> : null}</section>
        {!data.capabilities.canEditVehicles ? <div className="fc-readonly-note"><ShieldCheck size={18} /><span><strong>View-only vehicle access</strong><small>Your role can review status, documents and movement history.</small></span></div> : null}
      </section></div> : null}

      {lifecycleVehicle ? <FleetVehicleLifecycle data={{ ...data, vehicles }} onClose={() => setLifecycleVehicle(null)} vehicle={vehicles.find((item) => item.id === lifecycleVehicle.id) ?? lifecycleVehicle} /> : null}

      {addVehicle ? <div className="fc-modal-backdrop" role="presentation"><section aria-label="Add vehicle" className="fc-modal wide"><button aria-label="Close" className="fc-modal-close" onClick={() => setAddVehicle(false)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Plus size={25} /></span><div><small>Vehicle master</small><h2>Add a fleet vehicle</h2><p>Start with vehicle number, station, source and fuel. Add other details when needed.</p></div></div><form className="fc-add-form" onSubmit={createVehicle}><label><span>Vehicle number</span><input autoFocus name="vehicle_no" placeholder="KL 00 XX 0000" required /></label><label><span>Station</span><select name="station_code" required><option value="">Select station</option>{data.stationOptions.map((option) => <option key={option.code} value={option.code}>{option.code} · {option.name}</option>)}</select></label><label><span>Model</span><input name="model" placeholder="Optional · e.g. Mahindra Jeeto" /></label><label><span>Fuel type</span><select name="fuel_type" required><option value="">Select fuel</option><option>Diesel</option><option>Petrol</option><option>CNG</option><option>EV</option></select></label><label><span>Vehicle source</span><select value={newVehicleSourceId} onChange={event=>{setNewVehicleSourceId(event.target.value);setNewVehicleStatus("active");}} name="source_id" required><option value="">Select source</option>{sources.filter(s=>s.isActive).map(s=><option key={s.id} value={s.id}>{sourceTitle(s)}</option>)}</select></label><label><span>Status</span><select value={newVehicleStatus} onChange={event=>setNewVehicleStatus(event.target.value)} name="status">{vehicleStatusOptions.filter(option=>sourceApplies(option,newVehicleSource)).map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>{vehicleStatusOptions.find(s=>s.key===newVehicleStatus)?.requiresExpectedDate ? <label><span>Expected return</span><input name="expected_operational_date" type="date" min={data.today} required /></label> : null}{vehicleStatusOptions.find(s=>s.key===newVehicleStatus)?.requiresReason ? <label><span>Reason</span><select name="status_reason_id" required><option value="">Select reason</option>{vehicleStatusOptions.find(s=>s.key===newVehicleStatus)?.reasons.filter(r=>r.isActive).map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></label> : null}<label><span>Deployment date · cost starts</span><input name="deployment_date" type="date" defaultValue={data.today} max={data.today} required /><small>Choose the actual start date, including a past date.</small></label><FleetVehicleContactFields key={newVehicleSource} source={newVehicleSource} /><FleetVehicleRentFields /><details className="full fc-optional-master"><summary>Optional document dates</summary><div className="fc-add-form"><label><span>RC location</span><input name="rc_location" placeholder="RTO / station" /></label><label><span>Insurance expiry</span><input name="insurance_expiry" type="date" /></label><label><span>PUC expiry</span><input name="puc_expiry" type="date" /></label>{newVehicleSource === "own" ? <><label><span>Fitness expiry</span><input name="fitness_expiry" type="date" /></label><label><span>Tax validity</span><input name="tax_expiry" type="date" /></label></> : null}</div></details><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setAddVehicle(false)} type="button">Cancel</button><button className="fc-button primary" disabled={savingVehicle === "NEW"} type="submit">{savingVehicle === "NEW" ? "Adding…" : "Add vehicle"}</button></div></form></section></div> : null}

      {auditTemplateEditor ? <div className="fc-modal-backdrop"><section className="fc-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setAuditTemplateEditor(null)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><ClipboardCheck size={22} /></span><div><small>Masters · Vehicle Audit</small><h2>{auditTemplateEditor === "new" ? "Add audit template" : "Edit audit template"}</h2><p>Group a reusable checklist and define its audit cadence.</p></div></div><form className="fc-add-form" onSubmit={submitAuditTemplate}><label className="full"><span>Template name</span><input defaultValue={auditTemplateEditor === "new" ? "" : auditTemplateEditor.name} name="name" required /></label><label className="full"><span>Description</span><input defaultValue={auditTemplateEditor === "new" ? "" : auditTemplateEditor.description} name="description" placeholder="What this audit checks" /></label><label><span>Cadence in days</span><input defaultValue={auditTemplateEditor === "new" ? 30 : auditTemplateEditor.cadenceDays} max="365" min="1" name="cadenceDays" type="number" /></label><label className="fc-toggle"><input defaultChecked={auditTemplateEditor === "new" ? data.auditTemplates.length === 0 : auditTemplateEditor.isDefault} name="isDefault" type="checkbox" /><span>Default audit template</span></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setAuditTemplateEditor(null)} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === "audit-template.upsert"} type="submit">{savingAction ? "Saving…" : "Save template"}</button></div></form></section></div> : null}

      {documentTypeEditor ? <div className="fc-modal-backdrop"><section className="fc-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setDocumentTypeEditor(null)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><FileCheck2 size={22} /></span><div><small>Masters · Vehicle Documents</small><h2>{documentTypeEditor === "new" ? "Add document rule" : "Edit document rule"}</h2><p>Control the document choice, expiry requirement and alert timing.</p></div></div><form className="fc-add-form" onSubmit={submitDocumentType}><div className="full"><span>Applies to vehicle sources</span><div style={{display:"flex",gap:16,flexWrap:"wrap"}}>{vehicleSources.map(source=><label className="fc-toggle" key={source}><input name="ownershipTypes" type="checkbox" value={source} defaultChecked={((documentTypeEditor === "new" ? undefined : documentTypeEditor.ownershipTypes) ?? [...vehicleSources]).includes(source)} /><span>{source === "own" ? "Own" : source === "odcd" ? "ODCD" : "Rented"}</span></label>)}</div></div><label><span>Document name</span><input defaultValue={documentTypeEditor === "new" ? "" : documentTypeEditor.label} name="name" required /></label><label><span>Code</span><input defaultValue={documentTypeEditor === "new" ? "" : documentTypeEditor.value} name="code" placeholder="FLEET_PERMIT" readOnly={documentTypeEditor !== "new"} /></label><label><span>Validity rule</span><select defaultValue={documentTypeEditor === "new" ? "required" : documentTypeEditor.expiryMode} name="expiryMode"><option value="required">Expiry required</option><option value="optional">Expiry optional</option>{documentTypeEditor !== "new" && documentTypeEditor.value === "FLEET_REGISTRATION" ? <option value="linked_fitness">Validity follows Fitness</option> : null}</select></label><label><span>Reminder days</span><input defaultValue={documentTypeEditor === "new" ? 30 : documentTypeEditor.reminderDays} max="365" min="0" name="reminderDays" type="number" /></label><label><span>Sort order</span><input defaultValue={documentTypeEditor === "new" ? data.documentTypes.length * 10 + 10 : documentTypeEditor.sortOrder} min="0" name="sortOrder" type="number" /></label><label className="full"><span>Description</span><input defaultValue={documentTypeEditor === "new" ? "" : documentTypeEditor.description} name="description" placeholder="When Fleet should collect this document" /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setDocumentTypeEditor(null)} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === "document-type.upsert"} type="submit">{savingAction ? "Saving…" : "Save document rule"}</button></div></form></section></div> : null}

      {statusMasterEditor ? <div className="fc-modal-backdrop"><section className="fc-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setStatusMasterEditor(null)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Truck size={22} /></span><div><small>Masters · Vehicle Statuses</small><h2>{statusMasterEditor.kind === "status" ? `${statusMasterEditor.item ? "Edit" : "Add"} status` : `${statusMasterEditor.item ? "Edit" : "Add"} reason`}</h2><p>{statusMasterEditor.kind === "status" ? "Control the availability selector and required follow-up fields." : `Reason shown after ${statusMasterEditor.status.label} is selected.`}</p></div></div>{statusMasterEditor.kind === "status" ? <form className="fc-add-form" onSubmit={submitStatusMaster}><div className="full"><span>Applies to vehicle sources</span><div style={{display:"flex",gap:16,flexWrap:"wrap"}}>{vehicleSources.map(source=><label className="fc-toggle" key={source}><input name="ownershipTypes" type="checkbox" value={source} defaultChecked={(statusMasterEditor.item?.ownershipTypes ?? [...vehicleSources]).includes(source)} /><span>{source === "own" ? "Own" : source === "odcd" ? "ODCD" : "Rented"}</span></label>)}</div></div><label><span>Status name</span><input defaultValue={statusMasterEditor.item?.label} name="label" required /></label><label><span>Key</span><input defaultValue={statusMasterEditor.item?.key} name="key" placeholder="Generated from name" readOnly={Boolean(statusMasterEditor.item)} /></label><label className="full"><span>Short description</span><input defaultValue={statusMasterEditor.item?.helper} name="helper" placeholder="When this status should be used" /></label><label><span>Colour</span><select defaultValue={statusMasterEditor.item?.tone ?? "neutral"} name="tone"><option value="good">Green</option><option value="info">Blue</option><option value="warn">Amber</option><option value="bad">Red</option><option value="neutral">Grey</option></select></label><label><span>Sort order</span><input defaultValue={statusMasterEditor.item?.sortOrder ?? (data.vehicleStatuses.length + 1) * 10} min="0" name="sortOrder" type="number" /></label><label className="fc-toggle full"><input defaultChecked={statusMasterEditor.item?.isOperational ?? false} name="isOperational" type="checkbox" /><span>Vehicle is operational in this status</span></label><label className="fc-toggle full"><input defaultChecked={statusMasterEditor.item?.requiresReason ?? true} name="requiresReason" type="checkbox" /><span>Require a reason after this status is selected</span></label><label className="fc-toggle full"><input defaultChecked={statusMasterEditor.item?.requiresExpectedDate ?? false} name="requiresExpectedDate" type="checkbox" /><span>Require an expected operational date</span></label><label className="fc-toggle full"><input defaultChecked={statusMasterEditor.item?.isTerminal ?? false} name="isTerminal" type="checkbox" /><span>Closed vehicle lifecycle status</span></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setStatusMasterEditor(null)} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === "vehicle-status.upsert"} type="submit">{savingAction ? "Saving…" : "Save status"}</button></div></form> : <form className="fc-add-form" onSubmit={submitStatusReason}><label><span>Reason</span><input defaultValue={statusMasterEditor.item?.label} name="label" required /></label><label><span>Key</span><input defaultValue={statusMasterEditor.item?.key} name="key" placeholder="Generated from name" readOnly={Boolean(statusMasterEditor.item)} /></label><label className="full"><span>Short guidance</span><input defaultValue={statusMasterEditor.item?.helper} name="helper" placeholder="Help the Fleet Manager choose correctly" /></label><label><span>Sort order</span><input defaultValue={statusMasterEditor.item?.sortOrder ?? (statusMasterEditor.status.reasons.length + 1) * 10} min="0" name="sortOrder" type="number" /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setStatusMasterEditor(null)} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === "vehicle-status-reason.upsert"} type="submit">{savingAction ? "Saving…" : "Save reason"}</button></div></form>}</section></div> : null}
      {checklistModal ? <div className="fc-modal-backdrop"><section className="fc-modal wide fc-checklist-editor"><button aria-label="Close" className="fc-modal-close" onClick={() => { setChecklistModal(false); setChecklistEditing(null); }} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><ListChecks size={24} /></span><div><small>Masters · Vehicle Audit</small><h2>{checklistEditing ? "Edit audit control" : "Add audit control"}</h2><p>Define one clear inspection question and what proof is needed for each outcome.</p></div></div><form className="fc-add-form" onSubmit={submitChecklist}><label className="full"><span>Template</span><select defaultValue={checklistEditing?.templateId} disabled={Boolean(checklistEditing)} name="templateId" required>{data.auditTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select>{checklistEditing ? <input name="templateId" type="hidden" value={checklistEditing.templateId} /> : null}</label><label><span>Applies to</span><select defaultValue={checklistEditing?.auditMode ?? "both"} name="auditMode"><option value="both">Video and physical audits</option><option value="video">Video review only</option><option value="physical">Physical inspection only</option></select></label><label><span>Category</span><input defaultValue={checklistEditing?.category} name="category" placeholder="Documents, tyres, driving behaviour…" required /></label><label><span>Severity on failure</span><select defaultValue={checklistEditing?.failureSeverity ?? "medium"} name="failureSeverity"><option>low</option><option>medium</option><option>high</option><option>critical</option></select></label><label className="full"><span>Inspection question</span><input defaultValue={checklistEditing?.label} name="label" placeholder="Does the driver demonstrate safe and smooth driving behaviour?" required /></label><label className="full"><span>Short inspector guidance</span><textarea defaultValue={checklistEditing?.guidance} name="guidance" placeholder="What should the inspector verify?" rows={2} /></label><input type="hidden" name="responseType" value={checklistEditing?.responseType || "text"} /><label><span>Sort order</span><input defaultValue={checklistEditing?.sortOrder ?? data.checklistItems.length * 10 + 10} min="0" name="sortOrder" type="number" /></label><FleetAuditRuleEditor initial={checklistEditing?.responseConfig || (checklistEditing && ['text','number','date'].includes(checklistEditing.responseType) ? {kind:checklistEditing.responseType as 'text'|'number'|'date',options:[],fuels:[],documentType:'',unit:''} : null)} /><label className="fc-toggle full"><input defaultChecked={checklistEditing?.isRequired ?? true} name="isRequired" type="checkbox" /><span>Required checklist control</span></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => { setChecklistModal(false); setChecklistEditing(null); }} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === (checklistEditing ? "checklist.update" : "checklist.create")} type="submit">{savingAction ? "Saving…" : checklistEditing ? "Save changes" : "Add control"}</button></div></form></section></div> : null}

    <nav className="fc-bottom-nav" aria-label="Mobile navigation">{workspaceSections.filter(i=>['overview','attention','vehicles','audits'].includes(i.key)&&visibleSectionSet.has(i.key)).map(i=><button type="button" key={i.key} aria-current={section===i.key?'page':undefined} className={section===i.key?'active':''} onClick={()=>changeSection(i.key)}><i.icon size={21}/><span>{i.key==='overview'?'Home':i.key==='attention'?'Attention':i.key==='audits'?'Audits':'Vehicles'}</span></button>)}<button type="button" onClick={()=>setMobileNav(true)}><Menu size={21}/><span>More</span></button></nav></main></FleetVehicleMetadataProvider>
  );
}

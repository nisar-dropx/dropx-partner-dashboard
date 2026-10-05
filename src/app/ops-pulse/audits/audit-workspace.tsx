"use client";

import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  X,
} from "lucide-react";
import { SearchableSelect } from "@/components/searchable-select";
import type {
  AuditStation,
  AuditType,
  StationAudit,
  StationAuditWorkspace,
} from "@/lib/ops-pulse/station-audits";
import {
  addAuditDays,
  auditDay,
  auditLocalTime,
  auditMonthRange,
  auditPlanColumns,
  auditSlots,
  auditStatusLabel,
  auditTone,
  isFastAudit,
} from "@/lib/ops-pulse/station-audit-planning";
import { AuditMonthTracker } from "./audit-month-tracker";
import {
  auditQueueBucket,
  isMyAudit,
} from "@/lib/ops-pulse/station-audit-planning";
import { scheduleStationAudit } from "./actions";
import { AuditDetail, auditActor } from "./audit-detail";
import styles from "./audit-workspace.module.css";

const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date(`${date}T12:00:00+05:30`));
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(
    new Date(`${month}-01T12:00:00Z`),
  );
type Choice = { value: string; label: string };
type ScheduleSeed = {
  typeId?: string;
  stationId?: string;
  date?: string;
  slot?: string;
};

function MultiFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Choice[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const matches = options.filter((option) =>
    option.label.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div
      className={styles.multiFilter}
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        className={styles.filterButton}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        <strong>
          {selected.length ? `${selected.length} selected` : "All"} ▾
        </strong>
      </button>
      {open && (
        <div className={styles.filterMenu} id={id}>
          <input
            autoFocus
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className={styles.textButton}
            onClick={() => onChange([])}
          >
            Clear selection
          </button>
          <div className={styles.filterOptions}>
            {matches.map((option) => (
              <label key={option.value}>
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, option.value]
                        : selected.filter((item) => item !== option.value),
                    )
                  }
                />
                <span>{option.label}</span>
              </label>
            ))}
            {!matches.length && <p>No matches</p>}
          </div>
        </div>
      )}
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previous;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const box = ref.current!.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <header className={styles.modalHead}>
        <h2 id={id}>{title}</h2>
        <button
          aria-label="Close audit window"
          className={styles.iconButton}
          onClick={close}
        >
          <X size={20} />
        </button>
      </header>
      <div className={styles.modalBody}>{children}</div>
    </dialog>
  );
}
function Schedule({
  workspace,
  seed,
  onSaved,
  viewerId,
}: {
  workspace: StationAuditWorkspace;
  seed: ScheduleSeed;
  onSaved: () => void;
  viewerId: string;
}) {
  const types = workspace.auditTypes.filter((type) => type.is_active);
  const [typeId, setTypeId] = useState(seed.typeId || types[0]?.id || "");
  const type = types.find((row) => row.id === typeId);
  const [stationId, setStationId] = useState(seed.stationId || "");
  const [scheduledDate, setScheduledDate] = useState(
    seed.date && seed.date >= auditDay() ? seed.date : auditDay(),
  );
  const dateSlot = type
    ? auditSlots(type).find(
        (slot) =>
          Number(scheduledDate.slice(-2)) >= slot.startDay &&
          Number(scheduledDate.slice(-2)) <= slot.endDay,
      )
    : null;
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (pending) return;
        setPending(true);
        void (async () => {
          try {
            const result = await scheduleStationAudit(data);
            setNotice(result.message);
            if (result.ok) onSaved();
          } catch {
            setNotice("Unable to schedule. Please try again.");
          } finally {
            setPending(false);
          }
        })();
      }}
    >
      <p className={styles.muted}>
        Choose a date and time for this programme slot. Times are in India
        Standard Time.
      </p>
      <div className={styles.compactForm}>
        <label className={styles.inputLabel}>
          Audit type
          <select
            name="audit_type_id"
            value={typeId}
            onChange={(event) => setTypeId(event.target.value)}
          >
            {types.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.inputLabel}>
          Station
          <SearchableSelect
            name="location_id"
            required
            value={stationId}
            onValueChange={setStationId}
            placeholder="Search station"
            maxOptions={500}
            options={workspace.stations.map((station) => ({
              value: station.id,
              label: `${station.station_code} · ${station.station_name || station.city || ""}`,
            }))}
          />
        </div>
        <label className={styles.inputLabel}>
          Date
          <input
            name="scheduled_date"
            type="date"
            min={auditDay()}
            value={scheduledDate}
            onChange={(e) => setScheduledDate(e.target.value)}
            required
          />
        </label>
        <label className={styles.inputLabel}>
          Time (IST)
          <input
            key={typeId}
            name="scheduled_time"
            type="time"
            defaultValue={String(
              type?.scheduling_config.schedule_time || "09:00",
            )}
            required
          />
        </label>
        <div className={styles.inputLabel}>
          Audit window<strong>{dateSlot?.label || "Choose a date"}</strong>
          <small>
            {dateSlot
              ? `Days ${dateSlot.startDay}–${Math.min(dateSlot.endDay, Number(auditMonthRange(scheduledDate.slice(0, 7)).to.slice(-2)))}`
              : ""}
          </small>
          <input
            type="hidden"
            name="period_slot"
            value={dateSlot?.code || ""}
          />
        </div>
        <div className={styles.inputLabel}>
          Assigned auditor
          <SearchableSelect
            key={stationId}
            name="assigned_to"
            required
            defaultValue={
              workspace.assignees.some(
                (p) => p.id === viewerId && p.stationIds.includes(stationId),
              )
                ? viewerId
                : ""
            }
            placeholder={stationId ? "Search auditor" : "Select station first"}
            disabled={!stationId}
            maxOptions={100}
            options={workspace.assignees
              .filter((p) => p.stationIds.includes(stationId))
              .map((p) => ({ value: p.id, label: p.name, helper: p.role }))}
          />
          <small>
            Only active users with audit access to this station are listed.
          </small>
        </div>
        <label className={styles.inputLabel}>
          Purpose / context
          <input
            name="reason"
            placeholder="Routine coverage or follow-up"
            maxLength={500}
          />
        </label>
      </div>
      <div className={styles.actions}>
        <button className="button" disabled={pending || !stationId || !typeId}>
          {pending ? "Scheduling…" : "Schedule audit"}
        </button>
        <p role="status">{notice}</p>
      </div>
    </form>
  );
}
function Badge({ audit }: { audit: StationAudit }) {
  return (
    <span className={`${styles.status} ${styles[auditTone(audit)]}`}>
      {auditStatusLabel(audit.status_code)}
    </span>
  );
}

export function AuditWorkspace({
  workspace,
  canManage,
  canSchedule,
  canEdit,
  canRespond,
  stationOnly,
  viewerName,
  viewerRole,
  viewerId,
  canDelete,
  month,
  focusAuditId,
  canViewMaster,
  readOnly,
}: {
  workspace: StationAuditWorkspace;
  canManage: boolean;
  canSchedule: boolean;
  canEdit: boolean;
  canRespond: boolean;
  stationOnly: boolean;
  viewerName: string;
  viewerRole: string;
  viewerId: string;
  canDelete: boolean;
  month: string;
  focusAuditId?: string;
  canViewMaster: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(stationOnly ? "queue" : "mine");
  const [typeId, setTypeId] = useState("all");
  const [stations, setStations] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [airways, setAirways] = useState<string[]>([]);
  const [auditors, setAuditors] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [fastOnly, setFastOnly] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(focusAuditId || "");
  const [seed, setSeed] = useState<ScheduleSeed | null>(null);
  const [today, setToday] = useState(auditDay());
  const [navigationPending, navigate] = useTransition();
  useEffect(() => {
    const timer = window.setInterval(() => setToday(auditDay()), 30000);
    return () => clearInterval(timer);
  }, []);
  const range = auditMonthRange(month);
  const unique = (values: string[]) =>
    [...new Set(values.filter(Boolean))]
      .sort()
      .map((value) => ({ value, label: value }));
  const airwayOptions = workspace.options.filter(
    (option) => option.option_group === "airways",
  );
  const stationAirways = (stationId: string) =>
    airwayOptions
      .filter(
        (option) =>
          Array.isArray(option.metadata.station_ids) &&
          option.metadata.station_ids.includes(stationId),
      )
      .map((option) => option.id);
  const filteredStations = useMemo(
    () =>
      workspace.stations.filter(
        (station) =>
          (!stations.length || stations.includes(station.id)) &&
          (!clusters.length ||
            clusters.includes(
              station.cluster_name || station.cluster || "Unassigned",
            )) &&
          (!airways.length ||
            (stationAirways(station.id).length
              ? stationAirways(station.id).some((id) => airways.includes(id))
              : airways.includes("unassigned"))),
      ),
    [workspace.stations, workspace.options, stations, clusters, airways],
  );
  const stationIds = new Set(filteredStations.map((station) => station.id));
  const scopeAudits = workspace.audits.filter(
    (audit) =>
      stationIds.has(audit.location_id) &&
      (typeId === "all" || audit.audit_type_id === typeId) &&
      (!auditors.length ||
        auditors.includes(audit.assigned_name || "Unassigned")) &&
      (!query ||
        `${audit.audit_number} ${audit.stations?.station_code} ${audit.assigned_name} ${audit.stations?.station_name}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const visibleAudits = scopeAudits.filter(
    (audit) =>
      (status === "all" || auditTone(audit) === status) &&
      (!fastOnly || isFastAudit(audit)),
  );
  const monthAudits = visibleAudits.filter(
    (audit) =>
      auditDay(audit.scheduled_for) >= range.from &&
      auditDay(audit.scheduled_for) <= range.to,
  );
  const queue = (stationOnly ? visibleAudits : monthAudits).filter(
    (audit) => !["closed", "completed"].includes(audit.status_code),
  );
  const mine = visibleAudits.filter(
    (a) =>
      isMyAudit(a, viewerId) &&
      !["closed", "completed"].includes(a.status_code),
  );
  const history = (stationOnly ? visibleAudits : monthAudits).filter(
    (audit) => audit.completed_at,
  );
  const modalAudits = day
    ? visibleAudits.filter((audit) => auditDay(audit.scheduled_for) === day)
    : visibleAudits.filter((audit) => audit.id === selectedId);
  const selected =
    modalAudits.find((audit) => audit.id === selectedId) || modalAudits[0];
  const showAudit = (audit: StationAudit) => {
    setDay(null);
    setSelectedId(audit.id);
  };
  const close = () => {
    setDay(null);
    setSelectedId("");
    setSeed(null);
  };
  const changeMonth = (value: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
    close();
    const params = new URLSearchParams(searchParams.toString());
    params.set("month", value);
    params.delete("audit");
    navigate(() => router.push(`${pathname}?${params}`));
  };
  const shiftMonth = (amount: number) => {
    const date = new Date(`${month}-15T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + amount);
    changeMonth(date.toISOString().slice(0, 7));
  };
  const exportParams = new URLSearchParams({
    from: range.from,
    to: range.to,
    stations: filteredStations.map((s) => s.id).join(","),
    type: typeId,
    auditors: auditors.join("|"),
    status,
    fast: String(fastOnly),
    q: query,
  });
  const renderCard = (audit: StationAudit) => (
    <button
      key={audit.id}
      className={`${styles.auditCard} ${styles[`${auditTone(audit)}Border`]}`}
      onClick={() => showAudit(audit)}
    >
      <div>
        <h3>
          {audit.stations?.station_code} ·{" "}
          {workspace.auditTypes.find((t) => t.id === audit.audit_type_id)?.name}
        </h3>
        <p>{audit.audit_number}</p>
      </div>
      <div className={styles.auditMeta}>
        <strong>
          {dateLabel(auditDay(audit.scheduled_for))} ·{" "}
          {auditLocalTime(audit.scheduled_for)}
        </strong>
        <span>
          {audit.completed_at
            ? `Completed by ${auditActor(audit, workspace, "submitted")}`
            : `${audit.started_at ? "Auditing now" : "Assigned to"}: ${audit.assigned_name || "Unassigned"}`}
        </span>
      </div>
      <div className={styles.actions}>
        {audit.score_snapshot && <span className={styles.photoBadge}>{audit.score_snapshot.percentage ?? "—"}% · {audit.score_snapshot.rating}{audit.score_snapshot.provisional ? " · provisional" : ""}</span>}
        <Badge audit={audit} />
        {isFastAudit(audit) && <mark className={styles.fast}>≤10 min</mark>}
        <ChevronRight size={18} />
      </div>
    </button>
  );
  return (
    <div className={styles.workspace} aria-busy={navigationPending}>
      <div className={styles.topBar}>
        <div>
          <span className={styles.eyebrow}>Audit workspace</span>
          <h1>{stationOnly ? "Station audit responses" : "Station audits"}</h1>
          <p>
            {stationOnly
              ? "Surprise audits are never shown before completion. Open responses and completed history stay in your station scope."
              : "Plan the month, follow live audits and review the evidence."}
          </p>
        </div>
        <div className={styles.actions}>
          {canManage && (
            <>
              <MultiFilter
                label="Cluster"
                options={unique(
                  workspace.stations.map(
                    (s) => s.cluster_name || s.cluster || "Unassigned",
                  ),
                )}
                selected={clusters}
                onChange={setClusters}
              />
              <MultiFilter
                label="Airways"
                options={[
                  ...airwayOptions.map((option) => ({
                    value: option.id,
                    label: option.label,
                  })),
                  { value: "unassigned", label: "Unassigned" },
                ]}
                selected={airways}
                onChange={setAirways}
              />
            </>
          )}
          {canViewMaster && (
            <Link className="button secondary compact" href="/master/audits">
              Audit Master
            </Link>
          )}
          {canSchedule && (
            <button
              className="button compact"
              onClick={() =>
                setSeed({ typeId: typeId === "all" ? undefined : typeId })
              }
            >
              <Plus size={15} /> Schedule audit
            </button>
          )}
        </div>
      </div>
      <div className={styles.context}>
        <span>
          <strong>{viewerName}</strong>’s{" "}
          {tab === "calendar" ? "calendar" : "audit view"}{" "}
          <span className={styles.muted}>
            · {viewerRole}
            {readOnly ? " · Read-only preview" : ""}
          </span>
        </span>
        <span>
          {filteredStations.length} authorized{" "}
          {filteredStations.length === 1 ? "station" : "stations"} · All times
          IST
        </span>
      </div>
      <div className={styles.controlPanel}>
        <div className={styles.toolbar}>
          <MultiFilter
            label="Stations"
            options={workspace.stations.map((s) => ({
              value: s.id,
              label: `${s.station_code} · ${s.station_name || s.city || ""}`,
            }))}
            selected={stations}
            onChange={setStations}
          />
          {canManage && (
            <MultiFilter
              label="Auditor"
              options={unique(
                workspace.audits.map((a) => a.assigned_name || "Unassigned"),
              )}
              selected={auditors}
              onChange={setAuditors}
            />
          )}
          <label className={styles.search}>
            <Search size={16} />
            <input
              aria-label="Search audits"
              placeholder="Search station, auditor or audit ID"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="Audit status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="pending">Pending / in progress</option>
            <option value="complete">Completed</option>
          </select>
          <button
            className={styles.textButton}
            onClick={() => {
              setStations([]);
              setClusters([]);
              setAirways([]);
              setAuditors([]);
              setQuery("");
              setStatus("all");
              setFastOnly(false);
            }}
          >
            Reset filters
          </button>
        </div>
        <div className={styles.viewBar}>
          <div className={styles.typeSwitch} aria-label="Audit type">
            <button
              aria-pressed={typeId === "all"}
              onClick={() => setTypeId("all")}
            >
              All audits
            </button>
            {workspace.auditTypes
              .filter((t) => t.is_active)
              .map((type) => (
                <button
                  key={type.id}
                  aria-pressed={typeId === type.id}
                  onClick={() => setTypeId(type.id)}
                >
                  {type.code === "virtual_cod"
                    ? "COD audit"
                    : type.code === "physical_station"
                      ? "Physical audit"
                      : type.name}
                </button>
              ))}
          </div>
          {canManage && (
            <div className={styles.monthPicker}>
              <button
                aria-label="Previous month"
                onClick={() => shiftMonth(-1)}
              >
                <ChevronLeft size={16} />
              </button>
              <input
                aria-label="Audit month"
                type="month"
                value={month}
                onChange={(e) => changeMonth(e.target.value)}
              />
              <button aria-label="Next month" onClick={() => shiftMonth(1)}>
                <ChevronRight size={16} />
              </button>
              <button onClick={() => changeMonth(today.slice(0, 7))}>
                Today
              </button>
            </div>
          )}
        </div>
      </div>
      <div className={styles.summary}>
        <div className={styles.metric}>
          <span>Scheduled</span>
          <strong>
            {monthAudits.filter((a) => a.status_code === "scheduled").length}
          </strong>
          <small>Planned for {monthLabel(month)}</small>
        </div>
        <div className={styles.metric}>
          <span>In progress / pending</span>
          <strong>
            {
              (stationOnly ? visibleAudits : monthAudits).filter(
                (a) => auditTone(a) === "pending",
              ).length
            }
          </strong>
          <small>Live work and follow-up</small>
        </div>
        <div className={styles.metric}>
          <span>Completed</span>
          <strong>
            {
              (stationOnly ? visibleAudits : monthAudits).filter(
                (a) => auditTone(a) === "complete",
              ).length
            }
          </strong>
          <small>Closed audit records</small>
        </div>
        <div className={styles.metric}>
          <span>Quick audit checks</span>
          <strong>{history.filter(isFastAudit).length}</strong>
          <small>Completed in 10 minutes or less</small>
        </div>
      </div>
      <div className={styles.viewBar}>
        <div className={styles.tabs}>
          {(stationOnly
            ? [
                ["queue", "Open responses"],
                ["log", "Reports & history"],
              ]
            : [
                ["mine", "My audits"],
                ["tracker", "Team tracker"],
                ["queue", "Team queue"],
                ["plan", "Monthly plan"],
                ["calendar", "Calendar"],
                ["log", "Reports & history"],
              ]
          ).map(([key, name]) => (
            <button
              key={key}
              className={tab === key ? styles.active : ""}
              aria-pressed={tab === key}
              onClick={() => {
                setTab(key);
                setFastOnly(false);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        {canManage && (
          <Link
            className="button secondary compact"
            href={`/api/ops-pulse/audits/export?${exportParams}`}
          >
            Download Excel
          </Link>
        )}
      </div>
      <div className={styles.legend}>
        <span className={styles.complete}>● Completed</span>
        <span className={styles.pending}>● Pending / in progress</span>
        <span className={styles.scheduled}>● Scheduled</span>
        {tab === "log" && (
          <label>
            <input
              type="checkbox"
              checked={fastOnly}
              onChange={(e) => setFastOnly(e.target.checked)}
            />{" "}
            Only audits ≤10 minutes
          </label>
        )}
      </div>
      {workspace.truncated && (
        <p role="alert" className={styles.notice}>
          The first 1,500 audits are shown. Choose a narrower month to see all
          records.
        </p>
      )}
      {navigationPending && <p role="status">Loading {monthLabel(month)}…</p>}
      {tab === "mine" && (
        <section className={styles.personal}>
          <div className={styles.calendarHead}>
            <div>
              <h2>My audits · {viewerName}</h2>
              <p>
                Your assigned work across months · today is {dateLabel(today)}.
                Open an audit to start, reschedule or view the response.
              </p>
            </div>
          </div>
          <div className={styles.personalGrid}>
            {[
              ["overdue", "Overdue"],
              ["today", "Today"],
              ["next2", "Next 2 days"],
              ["week", "Later this week"],
              ["later", "Upcoming"],
              ["followup", "Awaiting response / review"],
            ].map(([key, label]) => {
              const rows = mine.filter(
                (a) => auditQueueBucket(a, today) === key,
              );
              return (
                <section key={key}>
                  <h3>
                    {label} <span>{rows.length}</span>
                  </h3>
                  <div className={styles.list}>
                    {rows.map(renderCard)}
                    {!rows.length && (
                      <p className={styles.muted}>Nothing waiting here.</p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </section>
      )}
      {tab === "tracker" && (
        <AuditMonthTracker
          workspace={workspace}
          stations={filteredStations}
          audits={monthAudits}
          onOpen={showAudit}
        />
      )}
      {tab === "queue" && (
        <div className={styles.list}>
          {queue.map(renderCard)}
          {!queue.length && (
            <div className={styles.empty}>No open audits match this view.</div>
          )}
        </div>
      )}
      {tab === "log" && (
        <div className={styles.list}>
          {[...history]
            .sort((a, b) =>
              String(b.completed_at).localeCompare(String(a.completed_at)),
            )
            .map(renderCard)}
          {!history.length && (
            <div className={styles.empty}>
              No completed audits match this view.
            </div>
          )}
        </div>
      )}
      {tab === "calendar" && (
        <section className={styles.calendarPanel}>
          <div className={styles.calendarHead}>
            <h2>
              <CalendarDays size={20} /> {monthLabel(month)}
            </h2>
            <strong className={styles.todayLabel}>
              Today · {dateLabel(today)}
            </strong>
          </div>
          <div className={styles.calendar}>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => (
              <div key={name} className={styles.weekday}>
                {name}
              </div>
            ))}
            {Array.from({ length: 42 }, (_, index) => {
              const date = addAuditDays(range.calendarFrom, index);
              const audits = visibleAudits.filter(
                (a) => auditDay(a.scheduled_for) === date,
              );
              return (
                <button
                  key={date}
                  className={`${styles.day} ${date === today ? styles.today : ""} ${date.slice(0, 7) !== month ? styles.outside : ""}`}
                  aria-current={date === today ? "date" : undefined}
                  aria-label={`${dateLabel(date)}${date === today ? ", today" : ""}, ${audits.length} audits`}
                  onClick={() => {
                    setDay(date);
                    setSelectedId("");
                  }}
                >
                  <strong>
                    {Number(date.slice(-2))}
                    {date === today && <span>Today</span>}
                  </strong>
                  {audits.slice(0, 3).map((a) => (
                    <span
                      key={a.id}
                      className={`${styles.dayEntry} ${styles[`${auditTone(a)}Border`]}`}
                    >
                      <b>{a.stations?.station_code}</b>
                      <span>
                        {auditLocalTime(a.scheduled_for)} ·{" "}
                        {auditStatusLabel(a.status_code)}
                      </span>
                    </span>
                  ))}
                  {audits.length > 3 && (
                    <small>+{audits.length - 3} more</small>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}
      {tab === "plan" &&
        workspace.auditTypes
          .filter(
            (type) =>
              type.is_active && (typeId === "all" || type.id === typeId),
          )
          .map((type) => (
            <MonthlyPlan
              key={type.id}
              type={type}
              month={month}
              stations={filteredStations.filter(
                (station) =>
                  !query ||
                  `${station.station_code} ${station.station_name}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
              )}
              allAudits={workspace.audits}
              visibleAudits={visibleAudits}
              canSchedule={canSchedule && !auditors.length && status === "all"}
              onOpen={showAudit}
              onSchedule={setSeed}
            />
          ))}
      {(day || selectedId || seed) && (
        <Modal
          title={
            seed
              ? "Schedule station audit"
              : day
                ? `Audits · ${dateLabel(day)}`
                : "Audit details"
          }
          close={close}
        >
          {seed ? (
            <Schedule
              workspace={workspace}
              seed={seed}
              viewerId={viewerId}
              onSaved={close}
            />
          ) : (
            <>
              {day && (
                <div className={styles.daySelector}>
                  {modalAudits.map((audit) => (
                    <button
                      key={audit.id}
                      aria-pressed={selected?.id === audit.id}
                      onClick={() => setSelectedId(audit.id)}
                    >
                      <b>{audit.stations?.station_code}</b> ·{" "}
                      {auditLocalTime(audit.scheduled_for)}
                      <span>
                        {
                          workspace.auditTypes.find(
                            (t) => t.id === audit.audit_type_id,
                          )?.name
                        }
                      </span>
                      <Badge audit={audit} />
                    </button>
                  ))}
                  {!modalAudits.length && (
                    <p>No audits match the current filters for this day.</p>
                  )}
                  {canSchedule && day >= today && (
                    <button
                      onClick={() =>
                        setSeed({
                          date: day,
                          typeId: typeId === "all" ? undefined : typeId,
                        })
                      }
                    >
                      + Schedule for this day
                    </button>
                  )}
                </div>
              )}
              {selected ? (
                <AuditDetail
                  key={selected.id}
                  audit={selected}
                  workspace={workspace}
                  canManage={canEdit}
                  canDelete={canDelete}
                  canPerform={canEdit && isMyAudit(selected, viewerId)}
                  onDeleted={close}
                  canRespond={canRespond}
                />
              ) : (
                !day && (
                  <p>
                    This audit is not available in the current view or your
                    authorized scope.
                  </p>
                )
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
function MonthlyPlan({
  type,
  month,
  stations,
  allAudits,
  visibleAudits,
  canSchedule,
  onOpen,
  onSchedule,
}: {
  type: AuditType;
  month: string;
  stations: AuditStation[];
  allAudits: StationAudit[];
  visibleAudits: StationAudit[];
  canSchedule: boolean;
  onOpen: (audit: StationAudit) => void;
  onSchedule: (seed: ScheduleSeed) => void;
}) {
  const columns = auditPlanColumns(type, month);
  const visible = new Set(visibleAudits.map((a) => a.id));
  return (
    <section className={styles.plan}>
      <div className={styles.calendarHead}>
        <div>
          <h2>{type.name}</h2>
          <p>
            {type.required_count}{" "}
            {type.required_count === 1 ? "audit" : "audits"} required{" "}
            {type.cadence_unit === "weekly" ? "each week" : "each month"} ·
            frequency from Audit Master
          </p>
        </div>
      </div>
      <div className={styles.tableScroll}>
        <table>
          <thead>
            <tr>
              <th>Station</th>
              {columns.map((column) => (
                <th key={column.key}>
                  {column.label}
                  <small>{column.hint}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stations.map((station) => (
              <tr key={station.id}>
                <th>
                  {station.station_code}
                  <small>{station.station_name || station.city}</small>
                </th>
                {columns.map((column) => {
                  const slotAudits = allAudits.filter(
                    (a) =>
                      a.location_id === station.id &&
                      a.audit_type_id === type.id &&
                      auditDay(a.scheduled_for) >= column.date &&
                      auditDay(a.scheduled_for) <= column.endDate,
                  );
                  return (
                    <td key={column.key}>
                      {slotAudits.length ? (
                        slotAudits.map((audit) =>
                          visible.has(audit.id) ? (
                            <button
                              key={audit.id}
                              className={`${styles.slot} ${styles[`${auditTone(audit)}Border`]}`}
                              onClick={() => onOpen(audit)}
                            >
                              <Badge audit={audit} />
                              <strong>
                                {dateLabel(auditDay(audit.scheduled_for))} ·{" "}
                                {auditLocalTime(audit.scheduled_for)}
                              </strong>
                              <small>
                                {audit.assigned_name || "Unassigned"}
                              </small>
                            </button>
                          ) : (
                            <span key={audit.id} className={styles.muted}>
                              Hidden by filter
                            </span>
                          ),
                        )
                      ) : (
                        <button
                          className={`${styles.slot} ${styles.emptySlot}`}
                          disabled={!canSchedule || column.endDate < auditDay()}
                          onClick={() =>
                            onSchedule({
                              typeId: type.id,
                              stationId: station.id,
                              date: column.date,
                              slot: column.code,
                            })
                          }
                        >
                          <Plus size={15} />
                          {column.endDate < auditDay()
                            ? "Not scheduled · period ended"
                            : `Schedule ${column.label.toLowerCase()}`}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!stations.length && (
          <p className={styles.empty}>No stations match your selection.</p>
        )}
      </div>
    </section>
  );
}

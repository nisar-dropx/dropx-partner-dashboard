"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Download, Eraser, GripVertical, PencilLine, Search, Send, Upload, UsersRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { importOpsRosterWorkbook, prepareOpsRoster, saveOpsRosterAssignments, submitOpsRoster } from "@/app/ops-pulse/rostering/actions";
import type { OpsRosterEntry, OpsRosterHoliday, OpsRosterPerson, OpsRosterPlan, OpsRosterShift } from "@/lib/ops-pulse/rostering";
import { formatShiftClock } from "@/lib/roster-plan-preference";
import {
  applyRosterDrop,
  decodeRosterDragPayload,
  encodeRosterDragPayload,
  moveIsoDate,
  nextRosterOccurrenceOnOrAfter,
  recurringTemplateDate,
  rosterAssignmentToDragPayload,
  rosterCoverage,
  rosterMonthMaxWeekStart,
  rosterWeek,
  rosterWeekInCurrentMonth,
  type RosterAssignmentValue,
  type RosterDragPayload,
  type RosterTool
} from "@/lib/ops-pulse/roster-interactions";
import styles from "./ops-roster-planner.module.css";

type PointerDragState = {
  pointerId: number;
  payload: RosterDragPayload;
  label: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
};

type CellPickerState = {
  person: OpsRosterPerson;
  date: string;
  top: number;
  left: number;
};

type PreparedEntry = {
  workerType: "employee" | "contractor";
  workerId: string;
  rosterDate: string;
  dayType: "working" | "weekly_off";
  shiftId: string | null;
  notes: string | null;
};

function personKey(person: Pick<OpsRosterPerson, "workerType" | "id">) { return `${person.workerType}:${person.id}`; }
function cellKey(person: Pick<OpsRosterPerson, "workerType" | "id">, date: string) { return `${personKey(person)}:${date}`; }
function compactTime(value: string) {
  const clock = formatShiftClock(value);
  return clock === "--:--" ? "" : clock;
}
function dayLabel(date: string) { return new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)); }
function dateLabel(date: string) { return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)); }
function fullDateLabel(date: string) { return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)); }
function rosterInstant(date: string, startTime = "00:00") { return new Date(`${date}T${startTime.slice(0, 5)}:00+05:30`).getTime(); }
function mondayOf(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - (day - 1));
  return value.toISOString().slice(0, 10);
}
function currentIstMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date());
}
type BulkPeriodMode = "week" | "month";
function remapCellKeyToTemplate(key: string, templateMonday: string) {
  const separator = key.lastIndexOf(":");
  return `${key.slice(0, separator)}:${recurringTemplateDate(templateMonday, key.slice(separator + 1))}`;
}
function initialAssignments(entries: Array<OpsRosterEntry | PreparedEntry>) {
  return new Map(entries.map((entry) => [
    `${entry.workerType}:${entry.workerId}:${entry.rosterDate}`,
    { dayType: entry.dayType, shiftId: entry.shiftId, notes: entry.notes } satisfies RosterAssignmentValue
  ]));
}

export function OpsRosterPlanner({
  stationId,
  stationCode,
  plan,
  blankPeriodStart,
  initialWeekStart,
  people,
  shifts,
  holidays,
  defaultShifts,
  canStart,
  editable,
  approvalSummary,
  approvalRequired,
  routeReady,
  today,
  nowIso,
  changeCutoffHours
}: {
  stationId: string;
  stationCode: string;
  plan: OpsRosterPlan | null;
  blankPeriodStart: string;
  initialWeekStart: string;
  people: OpsRosterPerson[];
  shifts: OpsRosterShift[];
  holidays: OpsRosterHoliday[];
  defaultShifts: Record<string, string | null>;
  canStart: boolean;
  editable: boolean;
  approvalSummary: string;
  approvalRequired: boolean;
  routeReady: boolean;
  today: string;
  nowIso: string;
  changeCutoffHours: number;
}) {
  const router = useRouter();
  const initial = useMemo(() => initialAssignments(plan?.entries ?? []), [plan?.entries]);
  const [assignments, setAssignments] = useState(initial);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [templateStart, setTemplateStart] = useState(plan?.periodStart ?? blankPeriodStart);
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  const [activePlanId, setActivePlanId] = useState<string | null>(plan?.id ?? null);
  const [query, setQuery] = useState("");
  const [workerType, setWorkerType] = useState("all");
  const [activeTool, setActiveTool] = useState<RosterTool | null>(shifts[0] ? { kind: "shift", shiftId: shifts[0].id } : null);
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [editingEnabled, setEditingEnabled] = useState(editable);
  const [cellPicker, setCellPicker] = useState<CellPickerState | null>(null);
  const [pointerDrag, setPointerDrag] = useState<PointerDragState | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [draggingLabel, setDraggingLabel] = useState<string | null>(null);
  const [draggingAssignment, setDraggingAssignment] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isSaving, startSaving] = useTransition();
  const [isImporting, startImporting] = useTransition();
  const [excelFileName, setExcelFileName] = useState<string | null>(null);
  const [bulkPeriodMode, setBulkPeriodMode] = useState<BulkPeriodMode>("week");
  const [bulkRosterMonth, setBulkRosterMonth] = useState(currentIstMonth);
  const [bulkWeekStart, setBulkWeekStart] = useState(() => mondayOf(today));
  const editingEnabledRef = useRef(editable);
  const pendingRecall = plan?.status === "pending_approval" && canStart && !editingEnabled;
  const assignmentsRef = useRef(initial);
  const activePlanIdRef = useRef<string | null>(plan?.id ?? null);
  const templateStartRef = useRef(plan?.periodStart ?? blankPeriodStart);
  const preparedPlanIdRef = useRef<string | null>(null);
  const preparingRef = useRef(false);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const dragDropHandledRef = useRef(false);
  const activeDragPayloadRef = useRef<RosterDragPayload | null>(null);

  const dates = useMemo(() => rosterWeekInCurrentMonth(weekStart, today), [today, weekStart]);
  const maxWeekStart = useMemo(() => rosterMonthMaxWeekStart(today), [today]);
  const holidayByDate = useMemo(() => new Map(holidays.map((holiday) => [holiday.calendarDate, holiday])), [holidays]);
  const shiftById = useMemo(() => new Map(shifts.map((shift) => [shift.id, shift])), [shifts]);
  const visiblePeople = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people.filter((person) => (workerType === "all" || person.workerType === workerType)
      && (!needle || `${person.name} ${person.code} ${person.designation}`.toLowerCase().includes(needle)));
  }, [people, query, workerType]);
  const projectedAssignments = useMemo(() => {
    const projected = new Map<string, RosterAssignmentValue>();
    for (const person of visiblePeople) for (const date of dates) {
      const assignment = assignments.get(cellKey(person, recurringTemplateDate(templateStart, date)));
      if (assignment) projected.set(cellKey(person, date), assignment);
    }
    return projected;
  }, [assignments, dates, templateStart, visiblePeople]);
  const coverage = useMemo(() => rosterCoverage(visiblePeople.map(personKey), dates, projectedAssignments), [dates, projectedAssignments, visiblePeople]);
  const submissionCoverage = useMemo(() => {
    const templateDates = rosterWeek(templateStart);
    const expected = people.length * templateDates.length;
    const ready = people.reduce((total, person) => total + templateDates.filter((date) => assignments.has(cellKey(person, date))).length, 0);
    return { expected, ready, missing: Math.max(0, expected - ready) };
  }, [assignments, people, templateStart]);
  const activeShift = activeTool?.kind === "shift" ? shiftById.get(activeTool.shiftId) : null;
  const interactionAllowed = (editingEnabled || canStart) && !isPreparing;
  const cutoffMessage = `Roster changes are allowed only until ${changeCutoffHours} hours before the rostered shift.`;

  const lockReason = useCallback((date: string, payload?: RosterDragPayload | null, fallback?: RosterAssignmentValue) => {
    if (date < today) return "Past roster dates cannot be edited.";
    if (date < templateStartRef.current) return `This roster change starts on ${dateLabel(templateStartRef.current)}. Earlier dates are view only.`;
    const assignment = payload?.tool.kind === "shift"
      ? { dayType: "working" as const, shiftId: payload.tool.shiftId, notes: null }
      : payload?.tool.kind === "weekly_off"
        ? { dayType: "weekly_off" as const, shiftId: null, notes: null }
        : fallback;
    const startTime = assignment?.dayType === "working" && assignment.shiftId
      ? shiftById.get(assignment.shiftId)?.startTime
      : "00:00";
    // Cut off against the weekday occurrence in the week being viewed (e.g. 12–13 Sep),
    // not an earlier same weekday in the template week (e.g. 5–6 Sep).
    const templateDate = recurringTemplateDate(templateStartRef.current, date);
    const cutoffDate = nextRosterOccurrenceOnOrAfter(templateDate, date > today ? date : today);
    return rosterInstant(cutoffDate, startTime) - new Date(nowIso).getTime() < changeCutoffHours * 60 * 60 * 1000 ? cutoffMessage : null;
  }, [changeCutoffHours, cutoffMessage, nowIso, shiftById, today]);

  useEffect(() => {
    editingEnabledRef.current = editable;
    setEditingEnabled(editable);
    activePlanIdRef.current = plan?.id ?? null;
    setActivePlanId(plan?.id ?? null);
    templateStartRef.current = plan?.periodStart ?? blankPeriodStart;
    setTemplateStart(plan?.periodStart ?? blankPeriodStart);
    setWeekStart(initialWeekStart);
    preparedPlanIdRef.current = null;
    preparingRef.current = false;
    setIsPreparing(false);
    assignmentsRef.current = initial;
    setAssignments(initial);
    setDirtyKeys(new Set());
    setSelectedPeople(new Set());
    setSelectedDates(new Set());
    setCellPicker(null);
  }, [blankPeriodStart, editable, initial, initialWeekStart, plan?.id, plan?.periodStart]);

  useEffect(() => {
    if (weekStart > maxWeekStart) setWeekStart(maxWeekStart);
  }, [maxWeekStart, weekStart]);

  const ensureEditing = useCallback(async () => {
    if (editingEnabledRef.current) return true;
    if (!canStart) {
      setMessage({
        tone: "error",
        text: plan?.status === "pending_approval"
          ? "This roster change is awaiting approval. You need planner access to recall and edit it."
          : "This roster is view only for your current access."
      });
      return false;
    }
    if (preparingRef.current) return false;
    preparingRef.current = true;
    setIsPreparing(true);
    setMessage({
      tone: "success",
      text: plan?.status === "pending_approval"
        ? "Recalling pending approval so you can edit…"
        : "Preparing an editable roster…"
    });
    let result: Awaited<ReturnType<typeof prepareOpsRoster>>;
    try {
      result = await prepareOpsRoster(stationId);
    } catch {
      preparingRef.current = false;
      setIsPreparing(false);
      setMessage({ tone: "error", text: "The editable roster could not be prepared. Please retry." });
      return false;
    }
    preparingRef.current = false;
    setIsPreparing(false);
    if (!result.ok || !result.planId || !result.periodStart) {
      setMessage({ tone: "error", text: result.message });
      return false;
    }
    const preparedAssignments = initialAssignments(result.entries ?? []);
    activePlanIdRef.current = result.planId;
    setActivePlanId(result.planId);
    preparedPlanIdRef.current = result.planId;
    templateStartRef.current = result.periodStart;
    setTemplateStart(result.periodStart);
    assignmentsRef.current = preparedAssignments;
    setAssignments(preparedAssignments);
    editingEnabledRef.current = true;
    setEditingEnabled(true);
    setDirtyKeys(new Set());
    setMessage({ tone: "success", text: result.message });
    router.refresh();
    return true;
  }, [canStart, plan?.status, router, stationId]);

  const bulkWeekMonday = useMemo(() => mondayOf(bulkWeekStart || today), [bulkWeekStart, today]);
  const bulkWeekSunday = useMemo(() => moveIsoDate(bulkWeekMonday, 6), [bulkWeekMonday]);

  const importWorkbook = useCallback((formData: FormData) => {
    if (!activePlanIdRef.current) {
      setMessage({ tone: "error", text: "Prepare or recall an editable roster before uploading." });
      return;
    }
    formData.set("plan_id", activePlanIdRef.current);
    formData.set("roster_period", bulkPeriodMode);
    formData.set("roster_month", bulkRosterMonth);
    formData.set("week_start", bulkWeekMonday);
    startImporting(async () => {
      const result = await importOpsRosterWorkbook(formData);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.message });
        return;
      }
      setExcelFileName(null);
      setMessage({ tone: "success", text: result.message });
      if (result.entries && result.periodStart) {
        const next = initialAssignments(result.entries);
        assignmentsRef.current = next;
        setAssignments(next);
        templateStartRef.current = result.periodStart;
        setTemplateStart(result.periodStart);
        setWeekStart(result.periodStart < initialWeekStart ? initialWeekStart : result.periodStart);
        setDirtyKeys(new Set());
      }
      router.refresh();
    });
  }, [bulkPeriodMode, bulkRosterMonth, bulkWeekMonday, initialWeekStart, router]);

  useEffect(() => {
    if (!cellPicker) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setCellPicker(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [cellPicker]);

  const commitDrop = useCallback((person: OpsRosterPerson, date: string, payload: RosterDragPayload) => {
    const targetKey = cellKey(person, recurringTemplateDate(templateStartRef.current, date));
    if (payload.sourceKey === targetKey) return;
    setAssignments((current) => {
      const next = applyRosterDrop(current, targetKey, payload).assignments;
      assignmentsRef.current = next;
      return next;
    });
    setDirtyKeys((current) => new Set([...current, targetKey, ...(payload.sourceKey ? [payload.sourceKey] : [])]));
    setMessage(null);
  }, []);

  const assignmentAt = useCallback((person: OpsRosterPerson, date: string, fallback?: RosterAssignmentValue) => {
    return assignmentsRef.current.get(cellKey(person, recurringTemplateDate(templateStartRef.current, date))) ?? fallback;
  }, []);

  const dropPayload = useCallback(async (person: OpsRosterPerson, date: string, payload: RosterDragPayload | null) => {
    if (!payload) return;
    dragDropHandledRef.current = true;
    if (!editingEnabledRef.current && !(await ensureEditing())) return;
    const reason = lockReason(date, payload, assignmentAt(person, date));
    if (reason) {
      setMessage({ tone: "error", text: reason });
      return;
    }
    const currentPayload = payload.sourceKey
      ? { ...payload, sourceKey: remapCellKeyToTemplate(payload.sourceKey, templateStartRef.current) }
      : payload;
    commitDrop(person, date, currentPayload);
    setCellPicker(null);
  }, [assignmentAt, commitDrop, ensureEditing, lockReason]);

  const removeAssignmentAtKey = useCallback((sourceKey: string) => {
    if (!editingEnabledRef.current) return;
    const key = remapCellKeyToTemplate(sourceKey, templateStartRef.current);
    setAssignments((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      assignmentsRef.current = next;
      return next;
    });
    setDirtyKeys((current) => new Set([...current, key]));
    setMessage(null);
  }, []);

  function openCellPicker(person: OpsRosterPerson, date: string, rect: DOMRect) {
    const pickerWidth = 248;
    const pickerHeight = Math.min(320, 72 + shifts.length * 44);
    setCellPicker({ person, date, top: Math.min(rect.bottom + 6, window.innerHeight - pickerHeight - 8), left: Math.min(Math.max(8, rect.left), window.innerWidth - pickerWidth - 8) });
  }

  async function handleCellClick(person: OpsRosterPerson, date: string, assignment: RosterAssignmentValue | undefined, event: ReactMouseEvent<HTMLElement>) {
    if (suppressClickRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!editingEnabledRef.current && !(await ensureEditing())) return;
    const currentAssignment = assignmentAt(person, date, assignment);
    const reason = lockReason(date, activeTool ? { tool: activeTool } : null, currentAssignment);
    if (reason) {
      setMessage({ tone: "error", text: reason });
      return;
    }
    if (currentAssignment) {
      openCellPicker(person, date, rect);
      return;
    }
    if (activeTool) {
      void dropPayload(person, date, { tool: activeTool });
      return;
    }
    openCellPicker(person, date, rect);
  }

  function handleCellContextMenu(person: OpsRosterPerson, date: string, event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    void ensureEditing().then((ready) => {
      if (!ready) return;
      const reason = lockReason(date, null, assignmentAt(person, date));
      if (reason) setMessage({ tone: "error", text: reason });
      else openCellPicker(person, date, rect);
    });
  }

  function applyPickerTool(tool: RosterTool) {
    if (cellPicker) void dropPayload(cellPicker.person, cellPicker.date, { tool });
  }

  async function applyBulk() {
    if (!editingEnabledRef.current && !(await ensureEditing())) return;
    if (!activeTool || !selectedPeople.size || !selectedDates.size) {
      setMessage({ tone: "error", text: "Select people, days and a shift or Week Off first." });
      return;
    }
    const cells = people.filter((person) => selectedPeople.has(personKey(person))).flatMap((person) => [...selectedDates].map((date) => ({ person, date })));
    const locked = cells.find((cell) => lockReason(cell.date, { tool: activeTool }, assignmentAt(cell.person, cell.date)));
    if (locked) {
      setMessage({ tone: "error", text: lockReason(locked.date, { tool: activeTool }, assignmentAt(locked.person, locked.date)) ?? cutoffMessage });
      return;
    }
    for (const cell of cells) commitDrop(cell.person, cell.date, { tool: activeTool });
  }

  async function fillDefaultShifts() {
    if (!editingEnabledRef.current && !(await ensureEditing())) return;
    const templateDates = rosterWeek(templateStartRef.current);
    const next = new Map(assignmentsRef.current);
    const dirty = new Set<string>();
    for (const person of people) {
      const shiftId = defaultShifts[personKey(person)];
      if (!shiftId || !shiftById.has(shiftId)) continue;
      for (const date of templateDates) {
        if (rosterInstant(nextRosterOccurrenceOnOrAfter(date, today), shiftById.get(shiftId)?.startTime) - new Date(nowIso).getTime() < changeCutoffHours * 60 * 60 * 1000) continue;
        const key = cellKey(person, date);
        if (next.has(key)) continue;
        next.set(key, { dayType: "working", shiftId, notes: null });
        dirty.add(key);
      }
    }
    if (!dirty.size) {
      setMessage({ tone: "error", text: "No empty cells could be filled. Assign default shifts in People profiles first." });
      return;
    }
    assignmentsRef.current = next;
    setAssignments(next);
    setDirtyKeys((current) => new Set([...current, ...dirty]));
    setMessage({ tone: "success", text: `${dirty.size} empty cell${dirty.size === 1 ? "" : "s"} filled from People profile shifts.` });
  }

  function save() {
    const planId = activePlanIdRef.current;
    if (!planId || !dirtyKeys.size) return;
    const changes = [...dirtyKeys].map((key) => {
      const [workerTypeValue, workerId, date] = key.split(":");
      const assignment = assignments.get(key);
      return assignment
        ? { workerType: workerTypeValue as "employee" | "contractor", workerId, date, dayType: assignment.dayType, shiftId: assignment.shiftId, notes: assignment.notes }
        : { workerType: workerTypeValue as "employee" | "contractor", workerId, date, remove: true as const };
    });
    startSaving(async () => {
      const result = await saveOpsRosterAssignments({ planId, changes, viewWeekStart: weekStart });
      setMessage({ tone: result.ok ? "success" : "error", text: result.message });
      if (result.ok) {
        setDirtyKeys(new Set());
        if (preparedPlanIdRef.current) {
          router.replace(`/rostering?station=${encodeURIComponent(stationCode)}`);
          router.refresh();
        }
      }
    });
  }

  function submit() {
    const planId = activePlanIdRef.current;
    if (!planId) return;
    startSaving(async () => {
      const result = await submitOpsRoster(planId);
      setMessage({ tone: result.ok ? "success" : "error", text: result.message });
      if (result.ok) router.refresh();
    });
  }

  function moveWeek(offset: number) {
    const next = moveIsoDate(weekStart, offset);
    if (next < initialWeekStart) setWeekStart(initialWeekStart);
    else if (next > maxWeekStart) setWeekStart(maxWeekStart);
    else setWeekStart(next);
    setSelectedDates(new Set());
  }

  function beginNativeDrag(event: DragEvent, payload: RosterDragPayload, label: string) {
    if (!interactionAllowed) {
      event.preventDefault();
      return;
    }
    dragDropHandledRef.current = false;
    activeDragPayloadRef.current = payload;
    setDraggingAssignment(Boolean(payload.sourceKey));
    const encoded = encodeRosterDragPayload(payload);
    event.dataTransfer.setData("application/x-dropx-roster", encoded);
    event.dataTransfer.setData("text/plain", encoded);
    event.dataTransfer.effectAllowed = payload.sourceKey ? "move" : "copy";
    setDraggingLabel(label);
  }

  function finishNativeDrag() {
    const payload = activeDragPayloadRef.current;
    if (payload?.sourceKey && !dragDropHandledRef.current) removeAssignmentAtKey(payload.sourceKey);
    activeDragPayloadRef.current = null;
    dragDropHandledRef.current = false;
    setDraggingAssignment(false);
    setDraggingLabel(null);
    setDropTargetKey(null);
  }

  function decodeDrop(event: DragEvent) {
    return decodeRosterDragPayload(event.dataTransfer.getData("application/x-dropx-roster") || event.dataTransfer.getData("text/plain"));
  }

  function beginPointerDrag(event: ReactPointerEvent, payload: RosterDragPayload, label: string) {
    if (event.pointerType === "mouse" || !interactionAllowed) return;
    if (!(event.target as Element).closest("[data-roster-drag-handle]")) return;
    const state = { pointerId: event.pointerId, payload, label, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
    activeDragPayloadRef.current = payload;
    dragDropHandledRef.current = false;
    pointerDragRef.current = state;
    setPointerDrag(state);
  }

  useEffect(() => {
    if (!pointerDrag) return;
    const handleMove = (event: PointerEvent) => {
      const current = pointerDragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const active = current.active || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 7;
      const next = { ...current, x: event.clientX, y: event.clientY, active };
      pointerDragRef.current = next;
      if (!current.active && active) {
        setPointerDrag(next);
        if (current.payload.sourceKey) setDraggingAssignment(true);
      }
      if (!active) return;
      event.preventDefault();
      suppressClickRef.current = true;
      if (dragGhostRef.current) {
        dragGhostRef.current.style.left = `${event.clientX}px`;
        dragGhostRef.current.style.top = `${event.clientY}px`;
      }
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-roster-drop-key]");
      setDropTargetKey(target?.dataset.rosterDropKey ?? null);
    };
    const finish = (event: PointerEvent, cancelled = false) => {
      const current = pointerDragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (current.active && !cancelled) {
        event.preventDefault();
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-roster-drop-key]");
        const person = people.find((candidate) => personKey(candidate) === target?.dataset.rosterPersonKey);
        const date = target?.dataset.rosterDate;
        if (person && date) void dropPayload(person, date, current.payload);
        else if (current.payload.sourceKey) removeAssignmentAtKey(current.payload.sourceKey);
      }
      pointerDragRef.current = null;
      setPointerDrag(null);
      setDropTargetKey(null);
      setDraggingAssignment(false);
      activeDragPayloadRef.current = null;
      if (current.active) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    const handleUp = (event: PointerEvent) => finish(event);
    const handleCancel = (event: PointerEvent) => finish(event, true);
    document.addEventListener("pointermove", handleMove, { passive: false });
    document.addEventListener("pointerup", handleUp, { passive: false });
    document.addEventListener("pointercancel", handleCancel, { passive: false });
    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", handleCancel);
    };
  }, [dropPayload, people, pointerDrag, removeAssignmentAtKey]);

  const allVisibleSelected = visiblePeople.length > 0 && visiblePeople.every((person) => selectedPeople.has(personKey(person)));
  const dockInstruction = interactionAllowed
    ? editingEnabled
      ? "Select a shift, click cells to assign, or drag between people and days."
      : pendingRecall
        ? "Pending approval — use Recall & edit to change this station pattern."
        : "Click a cell to open an editable draft of this station pattern."
    : "View only for your current access.";
  const status = editingEnabled && !plan ? "draft" : plan?.status ?? "blank";
  const templateHref = `/rostering/template?station=${encodeURIComponent(stationId)}${activePlanId ? `&plan=${encodeURIComponent(activePlanId)}` : ""}`;
  const canUseExcel = canStart || editingEnabled;
  const heroDetail = plan
    ? `Effective ${fullDateLabel(plan.effectiveFrom ?? plan.periodStart)} · v${plan.revisionNo} · repeats until replaced`
    : "Start editing to prepare this station’s recurring Monday–Sunday pattern.";

  return <section className={`${styles.workspace}${draggingLabel || pointerDrag?.active ? ` ${styles.isDragging}` : ""}`}>
    <header className={styles.hero}>
      <div>
        <span>{status === "approved" ? "Current approved roster" : status === "blank" ? "No roster configured" : status === "pending_approval" ? "Awaiting approval" : "Roster change in progress"}</span>
        <h2>{stationCode} · Monday to Sunday</h2>
        <p>{heroDetail}</p>
      </div>
      <div className={styles.heroActions}>
        {canStart && !editingEnabled ? (
          <button className="button primary compact" type="button" onClick={() => void ensureEditing()} disabled={isPreparing}>
            <PencilLine size={14} />
            {isPreparing ? (pendingRecall ? "Recalling…" : "Preparing…") : pendingRecall ? "Recall & edit" : plan ? "Edit roster" : "Start roster"}
          </button>
        ) : null}
        <div className={styles.stats}>
          <span><UsersRound size={15} /><strong>{people.length}</strong><small>active people</small></span>
          <span><CalendarDays size={15} /><strong>{submissionCoverage.ready}</strong><small>days assigned</small></span>
          <em className={`${styles.status} ${styles[String(status).replaceAll("_", "")] ?? ""}`}>{status.replaceAll("_", " ")}</em>
        </div>
      </div>
    </header>

    <div className={styles.toolbar}>
      <div className={styles.weekNavigation}><button type="button" aria-label="Previous week" onClick={() => moveWeek(-7)} disabled={weekStart <= initialWeekStart}><ChevronLeft size={16} /></button><span><CalendarDays size={15} /><strong>{dateLabel(dates[0])}</strong> to <strong>{dateLabel(dates[dates.length - 1] ?? dates[0])}</strong></span><button type="button" aria-label="Next week" onClick={() => moveWeek(7)} disabled={weekStart >= maxWeekStart}><ChevronRight size={16} /></button></div>
      <label className={styles.search}><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search person, ID or designation" /></label>
      <select aria-label="People type" value={workerType} onChange={(event) => setWorkerType(event.target.value)}><option value="all">Employees & contractors</option><option value="employee">Employees</option><option value="contractor">Independent contractors</option></select>
    </div>

    <div className={styles.shiftDock} aria-label="Shift assignment tools">
      <div className={styles.dockIntro}><Clock3 size={17} /><span><strong>Assignment dock</strong><small>{dockInstruction}</small></span></div>
      <div className={styles.shiftScroll}>
        {shifts.map((shift) => {
          const tool = { kind: "shift" as const, shiftId: shift.id };
          return <button key={shift.id} type="button" draggable={interactionAllowed} aria-label={`${shift.code} ${compactTime(shift.startTime)}–${compactTime(shift.endTime)}`} aria-pressed={activeTool?.kind === "shift" && activeTool.shiftId === shift.id} onDragStart={(event) => beginNativeDrag(event, { tool }, shift.code)} onDragEnd={finishNativeDrag} onPointerDown={(event) => beginPointerDrag(event, { tool }, shift.code)} onClick={() => { if (!suppressClickRef.current) setActiveTool(tool); }} className={`${styles.shiftChip}${activeTool?.kind === "shift" && activeTool.shiftId === shift.id ? ` ${styles.active}` : ""}`} style={{ "--shift-color": shift.color || "#cb4b65" } as CSSProperties}><span className={styles.dragGrip} data-roster-drag-handle aria-hidden="true"><GripVertical size={12} /></span><span>{shift.code}</span><small>{compactTime(shift.startTime)}–{compactTime(shift.endTime)}</small></button>;
        })}
        <button type="button" draggable={interactionAllowed} aria-pressed={activeTool?.kind === "weekly_off"} onDragStart={(event) => beginNativeDrag(event, { tool: { kind: "weekly_off" } }, "Week Off")} onDragEnd={finishNativeDrag} onPointerDown={(event) => beginPointerDrag(event, { tool: { kind: "weekly_off" } }, "Week Off")} onClick={() => { if (!suppressClickRef.current) setActiveTool({ kind: "weekly_off" }); }} className={`${styles.shiftChip} ${styles.off}${activeTool?.kind === "weekly_off" ? ` ${styles.active}` : ""}`}><span className={styles.dragGrip} data-roster-drag-handle aria-hidden="true"><GripVertical size={12} /></span><span>Week Off</span><small>No shift</small></button>
        <button type="button" draggable={interactionAllowed} aria-pressed={activeTool?.kind === "clear"} onDragStart={(event) => beginNativeDrag(event, { tool: { kind: "clear" } }, "Remove")} onDragEnd={finishNativeDrag} onPointerDown={(event) => beginPointerDrag(event, { tool: { kind: "clear" } }, "Remove")} onClick={() => { if (!suppressClickRef.current) setActiveTool({ kind: "clear" }); }} className={`${styles.shiftChip} ${styles.clear}${activeTool?.kind === "clear" ? ` ${styles.active}` : ""}`}><span className={styles.dragGrip} data-roster-drag-handle aria-hidden="true"><GripVertical size={12} /></span><Eraser size={14} /><span>Remove</span></button>
      </div>
    </div>

    {editingEnabled ? <div className={styles.bulkBar}><span><UsersRound size={15} /><strong>{selectedPeople.size}</strong> people · <strong>{selectedDates.size}</strong> days</span><span className={styles.activeTool}>Applying: <strong>{activeShift?.code ?? (activeTool?.kind === "weekly_off" ? "Week Off" : activeTool?.kind === "clear" ? "Remove" : "Select a shift")}</strong></span><button type="button" className="button secondary small" onClick={() => void fillDefaultShifts()}>Fill default shifts</button><button type="button" className="button secondary small" onClick={() => void applyBulk()}>Apply to selected</button><button type="button" className="button primary small" onClick={save} disabled={!dirtyKeys.size || isSaving}>{isSaving ? "Saving…" : `Save ${dirtyKeys.size || ""} changes`}</button></div> : null}
    {message ? <div className={`message-panel ${message.tone === "error" ? "error" : "success"}`} role="status">{message.text}</div> : null}

    <div className={styles.calendarWrap}>
      <table className={styles.calendar}>
        <thead><tr><th className={styles.personColumn}><label><input type="checkbox" checked={allVisibleSelected} onChange={() => setSelectedPeople(allVisibleSelected ? new Set() : new Set(visiblePeople.map(personKey)))} /> Person</label></th>{dates.map((date) => {
          const dayCoverage = coverage.get(date);
          const holiday = holidayByDate.get(date);
          return <th key={date} className={holiday ? styles.holiday : ""}><label><input type="checkbox" checked={selectedDates.has(date)} onChange={() => setSelectedDates((current) => { const next = new Set(current); if (next.has(date)) next.delete(date); else next.add(date); return next; })} /><span>{dayLabel(date)}<strong>{dateLabel(date)}</strong>{holiday ? <small title={holiday.name}>{holiday.name}</small> : null}</span></label><div className={styles.coverage}><span>{dayCoverage?.working ?? 0} on</span><span>{dayCoverage?.weeklyOff ?? 0} off</span><span className={(dayCoverage?.unassigned ?? 0) ? styles.warning : ""}>{dayCoverage?.unassigned ?? 0} open</span></div></th>;
        })}</tr></thead>
        <tbody>{visiblePeople.length ? visiblePeople.map((person) => <tr key={personKey(person)}><th className={styles.personColumn}><label><input type="checkbox" checked={selectedPeople.has(personKey(person))} onChange={() => setSelectedPeople((current) => { const next = new Set(current); if (next.has(personKey(person))) next.delete(personKey(person)); else next.add(personKey(person)); return next; })} /><span><strong>{person.name}</strong><small>{person.code} · {person.designation || (person.workerType === "employee" ? "Employee" : "Contractor")}</small><em>{person.workerType === "employee" ? "Employee" : "Independent contractor"}</em></span></label></th>{dates.map((date) => {
          const key = cellKey(person, recurringTemplateDate(templateStart, date));
          const assignment = assignments.get(key);
          const shift = assignment?.shiftId ? shiftById.get(assignment.shiftId) : null;
          const assignmentPayload = assignment ? rosterAssignmentToDragPayload(assignment, key) : null;
          const assignmentLabel = assignment?.dayType === "weekly_off" ? "Week Off" : shift?.code ?? "Assignment";
          const pickerOpen = cellPicker?.person.id === person.id && cellPicker.person.workerType === person.workerType && cellPicker.date === date;
          const reason = lockReason(date, activeTool ? { tool: activeTool } : null, assignment);
          const cellLabel = reason ?? (assignment ? `${assignmentLabel} for ${person.name} on ${dateLabel(date)}. Drag to move or click to change.` : `Assign ${activeShift?.code ?? "selected shift"} to ${person.name} on ${dateLabel(date)}`);
          return <td key={date} data-roster-drop-key={key} data-roster-person-key={personKey(person)} data-roster-date={date} className={`${holidayByDate.has(date) ? styles.holiday : ""} ${dirtyKeys.has(key) ? styles.dirty : ""} ${dropTargetKey === key ? styles.dropTarget : ""} ${pickerOpen ? styles.pickerOpen : ""} ${reason ? styles.locked : ""}`} onDragEnter={(event) => { if (interactionAllowed) { event.preventDefault(); setDropTargetKey(key); } }} onDragOver={(event) => { if (interactionAllowed) { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === "move" ? "move" : "copy"; setDropTargetKey(key); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetKey((current) => current === key ? null : current); }} onDrop={(event) => { event.preventDefault(); const payload = decodeDrop(event); setDraggingLabel(null); setDropTargetKey(null); void dropPayload(person, date, payload); }}>
            <button type="button" aria-label={cellLabel} title={reason ?? undefined} aria-haspopup={editingEnabled && Boolean(assignment) && !reason ? "dialog" : undefined} aria-expanded={pickerOpen || undefined} disabled={!interactionAllowed} draggable={interactionAllowed && !reason && Boolean(assignmentPayload)} onDragStart={(event) => { if (assignmentPayload && !reason) beginNativeDrag(event, assignmentPayload, assignmentLabel); else event.preventDefault(); }} onDragEnd={finishNativeDrag} onPointerDown={(event) => { if (assignmentPayload && !reason) beginPointerDrag(event, assignmentPayload, assignmentLabel); }} onClick={(event) => void handleCellClick(person, date, assignment, event)} onContextMenu={(event) => handleCellContextMenu(person, date, event)} className={`${styles.cell} ${assignment?.dayType === "weekly_off" ? styles.cellOff : shift ? styles.working : styles.emptyCell}${pickerOpen ? ` ${styles.pickerOpen}` : ""}${reason ? ` ${styles.lockedCell}` : ""}`} style={shift ? { "--shift-color": shift.color || "#cb4b65" } as CSSProperties : undefined}>{assignmentPayload && !reason ? <span className={styles.cellDragGrip} data-roster-drag-handle aria-hidden="true"><GripVertical size={11} /></span> : null}{assignment?.dayType === "weekly_off" ? <><strong>Week Off</strong><small>{reason ? "Locked" : "Rest day"}</small></> : shift ? <><strong>{shift.code}</strong><small>{reason ? "Locked" : `${compactTime(shift.startTime)}–${compactTime(shift.endTime)}`}</small></> : <><span>{reason ? "–" : "+"}</span><small>{reason ? "Locked" : "Assign"}</small></>}</button>
          </td>;
        })}</tr>) : <tr><td colSpan={Math.max(2, dates.length + 1)} className={styles.empty}>No active people match this view.</td></tr>}</tbody>
      </table>
    </div>

    <div className={styles.legend}><span><i className={styles.workingLegend} /> Working shift</span><span><i className={styles.offLegend} /> Week off</span><span><i className={styles.holidayLegend} /> Holiday</span><span><i className={styles.dirtyLegend} /> Unsaved change</span>{dirtyKeys.size ? <strong><Check size={13} /> Review and save {dirtyKeys.size} changes</strong> : editingEnabled ? <strong>No unsaved changes</strong> : <strong>Saved roster pattern</strong>}</div>
    {editingEnabled && activePlanId ? <footer className={styles.approvalLine}><span><strong>{dirtyKeys.size ? `Save ${dirtyKeys.size} change${dirtyKeys.size === 1 ? "" : "s"} first` : !submissionCoverage.ready ? "Add at least one assignment" : !routeReady ? "Approval setup required" : submissionCoverage.missing ? `${submissionCoverage.missing} cells remain unassigned` : approvalRequired ? "Ready to submit" : "Ready to apply"}</strong><small>{dirtyKeys.size ? "Unsaved assignments cannot be submitted." : !submissionCoverage.ready ? "A blank draft is kept safely and will not replace the current roster." : submissionCoverage.missing ? `${submissionCoverage.ready} assignments are ready. Unassigned people remain blank.` : approvalSummary}</small></span><button type="button" className="button primary compact" onClick={submit} disabled={Boolean(dirtyKeys.size || !submissionCoverage.ready || !routeReady || isSaving)}>{approvalRequired ? <Send size={14} /> : <Check size={14} />} {approvalRequired ? "Send for approval" : "Apply roster"}</button></footer> : null}
    {canUseExcel ? <section className={styles.excelPanel} aria-label="Station Excel upload">
      <div className={styles.excelHead}>
        <span className={styles.excelIcon} aria-hidden="true"><Upload size={16} /></span>
        <div>
          <strong>Excel upload</strong>
          <small>{stationCode} · choose a week or month, same as People</small>
        </div>
        <span className={styles.excelBadge}>Draft only</span>
        <span className={styles.excelBadgeMuted}>Submit for approval after import</span>
      </div>

      <div className={styles.excelPeriod}>
        <div className={styles.excelPeriodToggle} role="group" aria-label="Upload period">
          <button type="button" className={bulkPeriodMode === "week" ? styles.excelPeriodActive : undefined} onClick={() => setBulkPeriodMode("week")}>Week</button>
          <button type="button" className={bulkPeriodMode === "month" ? styles.excelPeriodActive : undefined} onClick={() => setBulkPeriodMode("month")}>Month</button>
        </div>
        {bulkPeriodMode === "week" ? (
          <label className={styles.excelPeriodField}>
            <span>Week starting</span>
            <input
              type="date"
              value={bulkWeekMonday}
              onChange={(event) => setBulkWeekStart(mondayOf(event.target.value || today))}
              disabled={isImporting}
            />
            <small>Mon {dateLabel(bulkWeekMonday)} → Sun {dateLabel(bulkWeekSunday)}</small>
          </label>
        ) : (
          <label className={styles.excelPeriodField}>
            <span>Roster month</span>
            <input
              type="month"
              value={bulkRosterMonth}
              onChange={(event) => setBulkRosterMonth(event.target.value)}
              disabled={isImporting}
            />
            <small>Writes only dates inside {bulkRosterMonth}</small>
          </label>
        )}
      </div>

      <ol className={styles.excelSteps}>
        <li>
          <em>1</em>
          <div>
            <strong>Download template</strong>
            <small>Mon–Sun pattern · WO for week off</small>
          </div>
          <a className="button secondary compact" download href={templateHref}><Download size={14} /> Download</a>
        </li>
        <li>
          <em>2</em>
          <div>
            <strong>Upload completed file</strong>
            <small>
              {editingEnabled && activePlanId
                ? (bulkPeriodMode === "week" ? "Imports the selected week into this draft" : `Applies the weekly pattern inside ${bulkRosterMonth}`)
                : pendingRecall ? "Recall & edit first, then upload" : "Start or edit the roster first"}
            </small>
          </div>
          {editingEnabled && activePlanId ? (
            <form action={importWorkbook} encType="multipart/form-data" className={styles.excelImportForm}>
              <label className={styles.excelFile}>
                <input
                  name="workbook"
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  required
                  disabled={isImporting}
                  onChange={(event) => setExcelFileName(event.target.files?.[0]?.name ?? null)}
                />
                <span>{excelFileName ?? "Choose file"}</span>
              </label>
              <button className="button primary compact" type="submit" disabled={isImporting}>
                {isImporting ? "Importing…" : `Import ${bulkPeriodMode}`}
              </button>
            </form>
          ) : (
            <button className="button secondary compact" type="button" onClick={() => void ensureEditing()} disabled={isPreparing || !canStart}>
              <PencilLine size={14} /> {pendingRecall ? "Recall & edit" : "Edit roster"}
            </button>
          )}
        </li>
      </ol>
    </section> : null}
    {pointerDrag?.active ? <div ref={dragGhostRef} className={styles.dragGhost} style={{ left: pointerDrag.x, top: pointerDrag.y }} aria-hidden="true"><GripVertical size={13} /> {pointerDrag.label}</div> : null}
    {cellPicker ? <><button type="button" className={styles.pickerBackdrop} aria-label="Close shift picker" onClick={() => setCellPicker(null)} /><div className={styles.picker} role="dialog" aria-label={`Change shift for ${cellPicker.person.name} on ${dateLabel(cellPicker.date)}`} style={{ top: cellPicker.top, left: cellPicker.left }}><header className={styles.pickerHead}><strong>{cellPicker.person.name}</strong><small>{dayLabel(cellPicker.date)} · {dateLabel(cellPicker.date)}</small></header><div className={styles.pickerList}>{shifts.map((shift) => <button key={shift.id} type="button" className={styles.pickerOption} style={{ "--shift-color": shift.color || "#cb4b65" } as CSSProperties} onClick={() => applyPickerTool({ kind: "shift", shiftId: shift.id })}><span className={styles.pickerSwatch} aria-hidden="true" /><span className={styles.pickerOptionContent}><strong>{shift.code}</strong><small>{compactTime(shift.startTime)} – {compactTime(shift.endTime)}</small></span></button>)}<button type="button" className={`${styles.pickerOption} ${styles.off}`} onClick={() => applyPickerTool({ kind: "weekly_off" })}><span className={styles.pickerSwatch} aria-hidden="true" /><span className={styles.pickerOptionContent}><strong>Week Off</strong><small>Rest day</small></span></button><button type="button" className={`${styles.pickerOption} ${styles.clear}`} onClick={() => applyPickerTool({ kind: "clear" })}><Eraser size={14} aria-hidden="true" /><span className={styles.pickerOptionContent}><strong>Remove</strong><small>Clear this assignment</small></span></button></div></div></> : null}
    {(draggingLabel || pointerDrag?.active) && draggingAssignment ? <div className={styles.removeHint} role="status">Drag outside the grid to remove this assignment</div> : null}
    <span className="sr-only" aria-live="polite">{draggingLabel || pointerDrag?.active ? `${draggingAssignment ? "Moving" : "Assigning"} ${draggingLabel ?? pointerDrag?.label}.` : ""}</span>
  </section>;
}

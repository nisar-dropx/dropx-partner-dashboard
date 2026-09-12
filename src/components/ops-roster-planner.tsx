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
import { isRosterChangePastDeadline, rosterChangeDeadlineMessage } from "@/lib/roster-change-deadline";
import {
  applyRosterDrop,
  decodeRosterDragPayload,
  encodeRosterDragPayload,
  moveIsoDate,
  nextRosterOccurrenceOnOrAfter,
  recurringTemplateDate,
  rosterAssignmentToDragPayload,
  rosterCoverage,
  rosterMonthEnd,
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
  changeDeadlineHour
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
  changeDeadlineHour: number;
}) {
  const router = useRouter();
  const initial = useMemo(() => initialAssignments(plan?.entries ?? []), [plan?.entries]);
  const [assignments, setAssignments] = useState(initial);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [templateStart, setTemplateStart] = useState(plan?.periodStart ?? blankPeriodStart);
  const [livePeriodEnd, setLivePeriodEnd] = useState(plan?.periodEnd ?? moveIsoDate(plan?.periodStart ?? blankPeriodStart, 6));
  const [liveRecurring, setLiveRecurring] = useState(plan?.status === "approved" && plan?.rosterKind === "recurring_weekly");
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
  // Excel upload only ever targets upcoming periods: the week picker's floor is next
  // Monday (the current week is excluded — matches roster edits being upcoming-only),
  // and the month picker's floor is the current month (today's remaining days through
  // month end are still fair game to upload), with future months always available.
  const [bulkRosterMonth, setBulkRosterMonth] = useState(currentIstMonth);
  const [bulkWeekStart, setBulkWeekStart] = useState(() => mondayOf(moveIsoDate(today, 7)));
  const editingEnabledRef = useRef(editable);
  const pendingRecall = plan?.status === "pending_approval" && canStart && !editingEnabled;
  const assignmentsRef = useRef(initial);
  const activePlanIdRef = useRef<string | null>(plan?.id ?? null);
  const templateStartRef = useRef(plan?.periodStart ?? blankPeriodStart);
  const preparedPlanIdRef = useRef<string | null>(null);
  const preparingRef = useRef(false);
  // Counts how many self-triggered navigations/refreshes (router.replace / router.refresh)
  // are still in flight from an action handler (prepare/save/submit/import). The
  // reconciliation effect below decrements this on every run while it's positive and
  // skips the destructive reset for each of those passes — not just the first. A single
  // boolean isn't enough here: save() fires BOTH router.replace() and router.refresh(),
  // which can each deliver their own separate prop-update pass, so a flag consumed on
  // the first pass would leave the second one unguarded and free to reset weekStart.
  const selfInitiatedRefreshCountRef = useRef(0);
  // Shares one in-flight prepareOpsRoster() call across concurrent callers
  // (right-click opening the picker, then picking an option) so they don't
  // double-prepare and race two router.refresh() calls against each other.
  const ensureEditingPromiseRef = useRef<Promise<boolean> | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const dragDropHandledRef = useRef(false);
  const activeDragPayloadRef = useRef<RosterDragPayload | null>(null);

  const isRecurring = liveRecurring;
  const monthEnd = useMemo(() => rosterMonthEnd(today), [today]);
  const dates = useMemo(() => {
    if (isRecurring) return rosterWeekInCurrentMonth(weekStart, today);
    return rosterWeek(weekStart).filter((date) => date >= templateStart && date <= livePeriodEnd && date <= monthEnd);
  }, [isRecurring, livePeriodEnd, monthEnd, templateStart, today, weekStart]);
  const maxWeekStart = useMemo(() => rosterMonthMaxWeekStart(today), [today]);
  const holidayByDate = useMemo(() => new Map(holidays.map((holiday) => [holiday.calendarDate, holiday])), [holidays]);
  const shiftById = useMemo(() => new Map(shifts.map((shift) => [shift.id, shift])), [shifts]);
  const visiblePeople = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people.filter((person) => (workerType === "all" || person.workerType === workerType)
      && (!needle || `${person.name} ${person.code} ${person.designation}`.toLowerCase().includes(needle)));
  }, [people, query, workerType]);
  const projectedAssignments = useMemo(() => {
    if (!isRecurring) return assignments;
    const projected = new Map<string, RosterAssignmentValue>();
    for (const person of visiblePeople) for (const date of dates) {
      const assignment = assignments.get(cellKey(person, recurringTemplateDate(templateStart, date)));
      if (assignment) projected.set(cellKey(person, date), assignment);
    }
    return projected;
  }, [assignments, dates, isRecurring, templateStart, visiblePeople]);
  const coverage = useMemo(() => rosterCoverage(visiblePeople.map(personKey), dates, projectedAssignments), [dates, projectedAssignments, visiblePeople]);
  const submissionCoverage = useMemo(() => {
    const coverageDates = isRecurring
      ? rosterWeek(templateStart)
      : rosterWeek(templateStart).filter((date) => date <= livePeriodEnd);
    const expected = people.length * coverageDates.length;
    const ready = people.reduce((total, person) => total + coverageDates.filter((date) => assignments.has(cellKey(person, date))).length, 0);
    return { expected, ready, missing: Math.max(0, expected - ready) };
  }, [assignments, isRecurring, livePeriodEnd, people, templateStart]);
  const activeShift = activeTool?.kind === "shift" ? shiftById.get(activeTool.shiftId) : null;
  const interactionAllowed = (editingEnabled || canStart) && !isPreparing;
  const cutoffMessage = rosterChangeDeadlineMessage(changeDeadlineHour);

  const lockReason = useCallback((date: string, _payload?: RosterDragPayload | null, _fallback?: RosterAssignmentValue) => {
    if (date < today) return "Past roster dates cannot be edited.";
    if (isRecurring && date < templateStartRef.current) return `This roster change starts on ${dateLabel(templateStartRef.current)}. Earlier dates are view only.`;
    if (!isRecurring && (date < templateStartRef.current || date > livePeriodEnd)) {
      return "This dated roster only covers its selected period. Dates outside it are view only.";
    }
    const templateOrDate = isRecurring ? recurringTemplateDate(templateStartRef.current, date) : date;
    const cutoffDate = isRecurring
      ? nextRosterOccurrenceOnOrAfter(templateOrDate, date > today ? date : today)
      : templateOrDate;
    return isRosterChangePastDeadline(cutoffDate, changeDeadlineHour, new Date(nowIso).getTime()) ? cutoffMessage : null;
  }, [changeDeadlineHour, cutoffMessage, isRecurring, livePeriodEnd, nowIso, today]);

  useEffect(() => {
    // A router.refresh()/router.replace() we triggered ourselves (prepare/save/submit/
    // import completing) brings back fresh props reflecting exactly what the action
    // handler already applied to local state. Re-running the full reset here would just
    // stomp that state back to stale values (e.g. dates snapping back, the Upload panel
    // disappearing). save() fires BOTH router.replace() and router.refresh(), which can
    // each deliver their own separate prop-update pass — so this is a COUNTER, not a
    // one-shot flag: every pass while the counter is positive is treated as self-
    // initiated and decrements it, so all of them are skipped, not just the first.
    if (selfInitiatedRefreshCountRef.current > 0) {
      selfInitiatedRefreshCountRef.current -= 1;
      const nextPlanId = plan?.id ?? null;
      if (activePlanIdRef.current !== nextPlanId && nextPlanId) {
        activePlanIdRef.current = nextPlanId;
        setActivePlanId(nextPlanId);
      }
      return;
    }
    // Genuine external change (station switch remounts anyway via the page's key, so this
    // path is for the plan mutating for a reason other than our own in-flight action — e.g.
    // another user/process editing the same station). Don't discard unsaved local edits;
    // let the user decide instead of silently reverting their work.
    if (dirtyKeys.size > 0) {
      setMessage({
        tone: "error",
        text: "This roster changed elsewhere. Your unsaved edits were kept — save or discard them before reloading."
      });
      return;
    }
    editingEnabledRef.current = editable;
    setEditingEnabled(editable);
    activePlanIdRef.current = plan?.id ?? null;
    setActivePlanId(plan?.id ?? null);
    const nextTemplateStart = plan?.periodStart ?? blankPeriodStart;
    templateStartRef.current = nextTemplateStart;
    setTemplateStart(nextTemplateStart);
    setLivePeriodEnd(plan?.periodEnd ?? moveIsoDate(plan?.periodStart ?? blankPeriodStart, 6));
    setLiveRecurring(plan?.status === "approved" && plan?.rosterKind === "recurring_weekly");
    // The view must never sit below the plan's own dated period start — "today's week"
    // (initialWeekStart) can be earlier than a future-dated draft's templateStart, and
    // nothing else corrects that (the mirror-image upper-bound clamp against
    // maxWeekStart already exists as its own effect below; this is the lower-bound
    // equivalent for the non-recurring case, applied right where templateStart changes).
    setWeekStart(initialWeekStart < nextTemplateStart ? nextTemplateStart : initialWeekStart);
    preparedPlanIdRef.current = null;
    preparingRef.current = false;
    setIsPreparing(false);
    assignmentsRef.current = initial;
    setAssignments(initial);
    setDirtyKeys(new Set());
    setSelectedPeople(new Set());
    setSelectedDates(new Set());
    setCellPicker(null);
    // `initial` deliberately excluded: it's a useMemo over plan?.entries, which the server
    // rebuilds via .map() on every request even when nothing changed, so it's never
    // referentially stable and would re-arm this effect on every render, defeating the
    // signature guard above. plan?.revisionNo only changes on a real save, so it's the
    // correct signal for "did the plan's content actually change" — the body above still
    // reads the freshly-computed `initial` value from this render's closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blankPeriodStart, editable, initialWeekStart, plan?.id, plan?.periodEnd, plan?.periodStart, plan?.revisionNo, plan?.rosterKind, plan?.status]);

  useEffect(() => {
    if (weekStart > maxWeekStart) setWeekStart(maxWeekStart);
  }, [maxWeekStart, weekStart]);

  // Mirror of the upper-bound clamp above: the view must never sit below the plan's own
  // dated period start (non-recurring case only — a recurring baseline has no such
  // floor). Self-heals regardless of which code path last set weekStart or templateStart.
  useEffect(() => {
    if (!isRecurring && weekStart < templateStart) setWeekStart(templateStart);
  }, [isRecurring, templateStart, weekStart]);

  const ensureEditing = useCallback(async () => {
    if (editingEnabledRef.current) return true;
    // Right-click-to-open-picker and the picker's own drop handler can both call this
    // in quick succession before the first prepare completes — share the one in-flight
    // call instead of firing prepareOpsRoster twice and racing two refreshes.
    if (ensureEditingPromiseRef.current) return ensureEditingPromiseRef.current;
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
    const promise = (async () => {
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
        result = await prepareOpsRoster(stationId, weekStart);
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
      const preparedPeriodStart = result.periodStart;
      activePlanIdRef.current = result.planId;
      setActivePlanId(result.planId);
      preparedPlanIdRef.current = result.planId;
      templateStartRef.current = preparedPeriodStart;
      setTemplateStart(preparedPeriodStart);
      const preparedPeriodEnd = result.periodEnd ?? moveIsoDate(preparedPeriodStart, 6);
      setLivePeriodEnd(preparedPeriodEnd);
      setLiveRecurring(false);
      // Keep whatever week the user had navigated to — prepareOpsRoster always anchors
      // the draft's OWN period to the current week server-side, but that's just where the
      // dated override starts; it must not yank the user's in-progress view back to today.
      // Only clamp if the current view has become genuinely out of range for the new
      // (dated, non-recurring) period.
      setWeekStart((current) => (current < preparedPeriodStart ? preparedPeriodStart : current > preparedPeriodEnd ? preparedPeriodEnd : current));
      assignmentsRef.current = preparedAssignments;
      setAssignments(preparedAssignments);
      editingEnabledRef.current = true;
      setEditingEnabled(true);
      setDirtyKeys(new Set());
      setMessage({ tone: "success", text: result.message });
      selfInitiatedRefreshCountRef.current += 1;
      router.refresh();
      return true;
    })();
    ensureEditingPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      ensureEditingPromiseRef.current = null;
    }
  }, [canStart, initialWeekStart, plan?.status, router, stationId, weekStart]);

  const bulkWeekMonday = useMemo(() => mondayOf(bulkWeekStart || today), [bulkWeekStart, today]);
  const bulkWeekSunday = useMemo(() => moveIsoDate(bulkWeekMonday, 6), [bulkWeekMonday]);
  // Upload can only ever target upcoming periods — the current (in-progress) week/month
  // is excluded for the week picker, but the month picker still allows the rest of the
  // current month (today through month end) since a month covers more than "this week."
  const minBulkWeekStart = useMemo(() => mondayOf(moveIsoDate(today, 7)), [today]);
  const minBulkMonth = useMemo(() => currentIstMonth(), []);

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
        const importedPeriodStart = result.periodStart;
        const next = initialAssignments(result.entries);
        assignmentsRef.current = next;
        setAssignments(next);
        templateStartRef.current = importedPeriodStart;
        setTemplateStart(importedPeriodStart);
        const importedPeriodEnd = result.periodEnd ?? moveIsoDate(importedPeriodStart, 6);
        setLivePeriodEnd(importedPeriodEnd);
        setLiveRecurring(false);
        // Same as ensureEditing: preserve the user's current view instead of snapping
        // back to the imported period's own start, unless the view is now out of range.
        setWeekStart((current) => (current < importedPeriodStart ? importedPeriodStart : current > importedPeriodEnd ? importedPeriodEnd : current));
        if (result.planId) {
          activePlanIdRef.current = result.planId;
          setActivePlanId(result.planId);
        }
        setDirtyKeys(new Set());
      }
      selfInitiatedRefreshCountRef.current += 1;
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
    const assignmentDate = isRecurring ? recurringTemplateDate(templateStartRef.current, date) : date;
    const targetKey = cellKey(person, assignmentDate);
    if (payload.sourceKey === targetKey) return;
    setAssignments((current) => {
      const next = applyRosterDrop(current, targetKey, payload).assignments;
      assignmentsRef.current = next;
      return next;
    });
    setDirtyKeys((current) => new Set([...current, targetKey, ...(payload.sourceKey ? [payload.sourceKey] : [])]));
    setMessage(null);
  }, [isRecurring]);

  const assignmentAt = useCallback((person: OpsRosterPerson, date: string, fallback?: RosterAssignmentValue) => {
    const assignmentDate = isRecurring ? recurringTemplateDate(templateStartRef.current, date) : date;
    return assignmentsRef.current.get(cellKey(person, assignmentDate)) ?? fallback;
  }, [isRecurring]);

  const dropPayload = useCallback(async (person: OpsRosterPerson, date: string, payload: RosterDragPayload | null) => {
    if (!payload) return;
    dragDropHandledRef.current = true;
    if (!editingEnabledRef.current && !(await ensureEditing())) return;
    const reason = lockReason(date, payload, assignmentAt(person, date));
    if (reason) {
      setMessage({ tone: "error", text: reason });
      return;
    }
    const currentPayload = payload.sourceKey && isRecurring
      ? { ...payload, sourceKey: remapCellKeyToTemplate(payload.sourceKey, templateStartRef.current) }
      : payload;
    commitDrop(person, date, currentPayload);
    setCellPicker(null);
  }, [assignmentAt, commitDrop, ensureEditing, isRecurring, lockReason]);

  const removeAssignmentAtKey = useCallback((sourceKey: string) => {
    if (!editingEnabledRef.current) return;
    const key = isRecurring ? remapCellKeyToTemplate(sourceKey, templateStartRef.current) : sourceKey;
    setAssignments((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      assignmentsRef.current = next;
      return next;
    });
    setDirtyKeys((current) => new Set([...current, key]));
    setMessage(null);
  }, [isRecurring]);

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
    const fillDates = isRecurring
      ? rosterWeek(templateStartRef.current)
      : dates;
    const next = new Map(assignmentsRef.current);
    const dirty = new Set<string>();
    for (const person of people) {
      const shiftId = defaultShifts[personKey(person)];
      if (!shiftId || !shiftById.has(shiftId)) continue;
      for (const date of fillDates) {
        const cutoffDate = isRecurring
          ? nextRosterOccurrenceOnOrAfter(date, today)
          : date;
        if (isRosterChangePastDeadline(cutoffDate, changeDeadlineHour, new Date(nowIso).getTime())) continue;
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
        if (result.planId && result.planId !== planId) {
          activePlanIdRef.current = result.planId;
          setActivePlanId(result.planId);
          preparedPlanIdRef.current = result.planId;
        }
        if (preparedPlanIdRef.current) {
          // router.replace() and router.refresh() can each deliver their own separate
          // prop-update pass to the reconciliation effect — count both so neither is
          // left unguarded (see selfInitiatedRefreshCountRef's declaration above).
          selfInitiatedRefreshCountRef.current += 2;
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
      if (result.ok) {
        selfInitiatedRefreshCountRef.current += 1;
        router.refresh();
      }
    });
  }

  // Ops roster edits only ever apply to upcoming days, so the floor for navigation is
  // the current week (initialWeekStart) — never earlier. Forward is always available;
  // Back only appears once the user has actually navigated away from the current week,
  // so they have a way to return to where they started without overshooting into the
  // past.
  function moveWeekForward() {
    const next = moveIsoDate(weekStart, 7);
    if (isRecurring) {
      if (next > maxWeekStart) return;
      setWeekStart(next);
    } else {
      if (next > livePeriodEnd) return;
      setWeekStart(next);
    }
    setSelectedDates(new Set());
  }

  function moveWeekBack() {
    const next = moveIsoDate(weekStart, -7);
    setWeekStart(next < initialWeekStart ? initialWeekStart : next);
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
        ? "Pending approval — use Recall & edit to change this station roster."
        : "Click a cell to open an editable dated draft for this station."
    : "View only for your current access.";
  const status = editingEnabled && !plan ? "draft" : plan?.status ?? "blank";
  const templateHref = `/rostering/template?station=${encodeURIComponent(stationId)}${activePlanId ? `&plan=${encodeURIComponent(activePlanId)}` : ""}`;
  // Excel follows the same gate as the grid: only once an editable draft is open.
  const canUseExcel = editingEnabled && Boolean(activePlanId);
  const heroDetail = isRecurring
    ? `Effective ${fullDateLabel(plan?.effectiveFrom ?? plan?.periodStart ?? blankPeriodStart)} · v${plan?.revisionNo ?? 1} · repeats until replaced`
    : plan
      ? `Dated ${fullDateLabel(templateStart)} → ${fullDateLabel(livePeriodEnd)} · v${plan.revisionNo} · only these dates change`
      : "Start editing to prepare a dated Monday–Sunday roster for this station.";

  return <section className={`${styles.workspace}${draggingLabel || pointerDrag?.active ? ` ${styles.isDragging}` : ""}`}>
    <header className={styles.hero}>
      <div>
        <span>{status === "approved" ? "Current approved roster" : status === "blank" ? "No roster configured" : status === "pending_approval" ? "Awaiting approval" : "Roster change in progress"}</span>
        <h2>{stationCode} · {isRecurring ? "Monday to Sunday pattern" : "Dated roster"}</h2>
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
      <div className={styles.weekNavigation}>
        {weekStart > initialWeekStart ? <button type="button" aria-label="Back to current week" onClick={moveWeekBack}><ChevronLeft size={16} /></button> : null}
        <span><CalendarDays size={15} /><strong>{dateLabel(dates[0] ?? weekStart)}</strong> to <strong>{dateLabel(dates[dates.length - 1] ?? dates[0] ?? weekStart)}</strong></span>
        <button type="button" aria-label="Next week" onClick={moveWeekForward} disabled={isRecurring ? weekStart >= maxWeekStart : moveIsoDate(weekStart, 7) > livePeriodEnd}><ChevronRight size={16} /></button>
      </div>
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
          const assignmentDate = isRecurring ? recurringTemplateDate(templateStart, date) : date;
          const key = cellKey(person, assignmentDate);
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
          <small>{stationCode} · week or month · dated (non-recurring) only</small>
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
              min={minBulkWeekStart}
              onChange={(event) => {
                const monday = mondayOf(event.target.value || minBulkWeekStart);
                setBulkWeekStart(monday < minBulkWeekStart ? minBulkWeekStart : monday);
              }}
              disabled={isImporting}
            />
            <small>Mon {dateLabel(bulkWeekMonday)} → Sun {dateLabel(bulkWeekSunday)} · upcoming week only</small>
          </label>
        ) : (
          <label className={styles.excelPeriodField}>
            <span>Roster month</span>
            <input
              type="month"
              value={bulkRosterMonth}
              min={minBulkMonth}
              onChange={(event) => {
                const value = event.target.value || minBulkMonth;
                setBulkRosterMonth(value < minBulkMonth ? minBulkMonth : value);
              }}
              disabled={isImporting}
            />
            <small>Expands Mon–Sun across every day in {bulkRosterMonth} from today onward · this month or any upcoming month</small>
          </label>
        )}
      </div>

      <ol className={styles.excelSteps}>
        <li>
          <em>1</em>
          <div>
            <strong>Download template</strong>
            <small>Mon–Sun columns · WO for week off</small>
          </div>
          <a className="button secondary compact" download href={templateHref}><Download size={14} /> Download</a>
        </li>
        <li>
          <em>2</em>
          <div>
            <strong>Upload completed file</strong>
            <small>
              {editingEnabled && activePlanId
                ? (bulkPeriodMode === "week"
                  ? "Imports the selected week only into this dated draft"
                  : `Expands Mon–Sun across every day in ${bulkRosterMonth}`)
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

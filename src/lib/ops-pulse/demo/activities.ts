import * as shift from "@/lib/ops-pulse/si-handover/model";
import * as store from "@/lib/ops-pulse/store-ops/model";
import { defaultSiTemplate } from "@/lib/ops-pulse/si-handover/template";
import { defaultStoreOpsTemplate } from "@/lib/ops-pulse/store-ops/template";
import type { ReportPack } from "@/lib/ops-pulse/checklist-report-pack";
export const sampleStores = ["Cedar Park", "Orchid Square", "Maple Grove"].map(
  (name, i) => ({
    id: `sample-store-${i + 1}`,
    station_code: `QC0${i + 1}`,
    station_name: name,
    city: "Sample city",
  }),
);
export const sampleActor: store.Actor = {
  userId: "sample-alex",
  displayName: "Alex Rao",
  isMasterOwner: true,
  effectiveRoleIds: [],
  hasAllLocationAccess: true,
  locationScopeIds: sampleStores.map((s) => s.id),
  readOnly: false,
  permissions: {
    si_handover: { canView: true, canAdd: true, canEdit: true },
    store_ops: { canView: true, canAdd: true, canEdit: true },
  },
};
export type ActivityState = {
  shifts: shift.SiChecklist[];
  stores: store.StoreOpsChecklist[];
  evidence: shift.Evidence[];
};
export function sampleAnswers(template: shift.Template | store.Template) {
  return Object.fromEntries(
    template.sections
      .flatMap<shift.Task | store.Task>((s) => s.tasks)
      .map((t) => [
        t.id,
        {
          ...shift.emptyAnswer(),
          outcome: "yes" as const,
          numbers: Object.fromEntries(
            t.numberFields.map((f) => [
              f.key,
              /freezer/i.test(f.key)
                ? "-20"
                : /ambient/i.test(f.key)
                  ? "22"
                  : /tropical/i.test(f.key)
                    ? "14"
                    : /chiller|temp/i.test(f.key)
                      ? "4"
                      : /rate|percent|sla/i.test(f.key)
                        ? "98"
                        : /fuel/i.test(f.key)
                          ? "85"
                          : /guards|security/i.test(f.key)
                            ? "2"
                            : /bags/i.test(f.key)
                              ? "1500"
                              : /ft/i.test(f.key)
                                ? "12"
                                : /pt/i.test(f.key)
                                  ? "4"
                                  : "8",
            ]),
          ),
          lines:
            t.answerType === "line_items"
              ? [
                  Object.fromEntries(
                    t.numberFields.map((f) => [
                      f.key,
                      f.options?.[0] ||
                        (/time|in|out/i.test(f.key) ? "08:00" : "DEMO-01"),
                    ]),
                  ),
                ]
              : [],
          text:
            t.answerType === "text"
              ? "Sample shift checks completed. Replenishment follow-up assigned to incoming shift."
              : "",
        },
      ]),
  );
}
export function sampleProof(
  checklistId: string,
  taskId: string,
): shift.Evidence {
  return {
    id: `sample-proof-${checklistId}-${taskId}-${Math.random().toString(36).slice(2, 7)}`,
    checklist_id: checklistId,
    task_id: taskId,
    file_name: "SAMPLE-store-evidence.svg",
    content_type: "image/svg+xml",
    size: 900,
    path: "/demo-assets/evidence.svg",
    ready: true,
    captured_at: new Date().toISOString(),
    latitude: null,
    longitude: null,
    uploaded_by: sampleActor.userId,
    created_at: new Date().toISOString(),
  };
}
export function newShift(
  locationId: string,
  date: string,
  slot: shift.ShiftSlot,
): shift.SiChecklist {
  const location =
      sampleStores.find((s) => s.id === locationId) || sampleStores[0],
    now = new Date().toISOString();
  return {
    id: `sample-shift-${locationId}-${date}-${slot}`,
    company_id: "sample-company",
    location_id: location.id,
    store_code: location.station_code,
    store_name: location.station_name,
    shift_date: date,
    shift_slot: slot,
    status: "open",
    template: defaultSiTemplate(),
    template_version: 1,
    answers: {},
    rejection: null,
    open_issues: "",
    events: [],
    version: 1,
    outgoing_user_id: sampleActor.userId,
    outgoing_name: sampleActor.displayName,
    incoming_user_id: null,
    incoming_name: null,
    started_at: new Date(`${date}T${slot}:00+05:30`).toISOString(),
    submitted_at: null,
    accepted_at: null,
    rejected_at: null,
    accepted_by: null,
    rejected_by: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}
export function newStore(
  locationId: string,
  date: string,
): store.StoreOpsChecklist {
  const location =
      sampleStores.find((s) => s.id === locationId) || sampleStores[0],
    now = new Date().toISOString();
  return {
    id: `sample-day-${locationId}-${date}`,
    company_id: "sample-company",
    location_id: location.id,
    store_code: location.station_code,
    store_name: location.station_name,
    work_date: date,
    status: "open",
    template: defaultStoreOpsTemplate(),
    template_version: 1,
    answers: {},
    day_summary: "",
    events: [],
    version: 1,
    owner_user_id: sampleActor.userId,
    owner_name: sampleActor.displayName,
    started_at: now,
    submitted_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}
export function activitySeed(): ActivityState {
  const today = store.todayIst(),
    cur = shift.currentShift(new Date(), shift.DEFAULT_SHIFT_SLOTS),
    now = new Date().toISOString();
  const state: ActivityState = { shifts: [], stores: [], evidence: [] };
  for (let day = 0; day < 7; day++) {
    const d = new Date(`${today}T12:00:00+05:30`);
    d.setDate(d.getDate() - day);
    const date = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    sampleStores.forEach((location, i) => {
      const slots = day === 0 ? [cur.shiftSlot] : shift.DEFAULT_SHIFT_SLOTS;
      const rows = slots.map((slot) => {
        const row = newShift(location.id, date, slot);
        row.answers = sampleAnswers(row.template);
        row.outgoing_name = ["Alex Rao", "Maya Das", "Leena Shah"][i];
        row.outgoing_user_id =
          i === 0 ? sampleActor.userId : `sample-person-${i}`;
        row.status =
          day === 0
            ? i === 0
              ? "open"
              : i === 1
                ? "submitted"
                : "accepted"
            : "accepted";
        if (row.status !== "open") row.submitted_at = now;
        if (row.status === "accepted") {
          row.accepted_at = now;
          row.incoming_name = "Arjun Sen";
          row.accepted_by = "sample-arjun";
        }
        if (day === 0 && i === 0) delete row.answers.A1;
        state.shifts.push(row);
        return row;
      });
      const daily = newStore(location.id, date);
      daily.answers = sampleAnswers(daily.template);
      daily.owner_name = ["Alex Rao", "Maya Das", "Leena Shah"][i];
      daily.owner_user_id = i === 0 ? sampleActor.userId : `sample-person-${i}`;
      daily.status = day === 0 && i === 0 ? "open" : "submitted";
      daily.submitted_at = daily.status === "submitted" ? now : null;
      state.stores.push(daily);
      for (const record of [...rows, daily])
        for (const task of record.template.sections.flatMap<
          shift.Task | store.Task
        >((s) => s.tasks))
          for (let n = 0; n < task.proof.min; n++)
            state.evidence.push(sampleProof(record.id, task.id));
    });
  }
  return state;
}
export function activityPack(
  state: ActivityState,
  kind: "shift" | "store",
  id: string,
): ReportPack | null {
  const row =
    kind === "shift"
      ? state.shifts.find((r) => r.id === id)
      : state.stores.find((r) => r.id === id);
  if (!row) return null;
  const sr = row as shift.SiChecklist,
    dr = row as store.StoreOpsChecklist;
  const p =
    kind === "shift"
      ? shift.progress(sr, {
          city: "Sample city",
          settings: shift.defaultSettings(),
        })
      : store.progress(dr, {
          city: "Sample city",
          settings: store.defaultSettings(),
          weeklyDoneIds: new Set(),
          monthlyDoneIds: new Set(),
        });
  return {
    kind,
    editUrl: `/${kind === "shift" ? "si-handover" : "store-ops"}?id=${id}&view=start`,
    checklist: {
      id,
      store_code: `SAMPLE · ${row.store_code}`,
      store_name: row.store_name,
      shift_date: sr.shift_date,
      shift_slot: sr.shift_slot,
      work_date: dr.work_date,
      status: row.status,
      statusLabel:
        kind === "shift"
          ? shift.statusLabels[sr.status]
          : store.statusLabels[dr.status],
      person_name: sr.outgoing_name || dr.owner_name,
      incoming_name: sr.incoming_name,
      started_at: row.started_at,
      updated_at: row.updated_at,
      submitted_at: row.submitted_at,
      accepted_at: sr.accepted_at,
      answered: p.answered,
      total: p.total,
      pct: p.pct,
      notes: sr.open_issues || dr.day_summary || "Fictional demo record",
    },
    sections: row.template.sections.map((s) => ({
      id: s.id,
      name: s.name,
      tasks: s.tasks.map((t) => ({
        id: t.id,
        label: t.label,
        answerType: t.answerType,
        ...(row.answers[t.id] || shift.emptyAnswer()),
      })),
    })),
    proofs: state.evidence
      .filter((p) => p.checklist_id === id)
      .map((p) => ({ ...p, url: "/demo-assets/evidence.svg" })),
  };
}

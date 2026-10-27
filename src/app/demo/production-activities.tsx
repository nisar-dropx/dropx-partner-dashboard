"use client";
import { useEffect, useRef, useState } from "react";
import { SiHandoverWorkspace } from "@/app/ops-pulse/si-handover/workspace";
import { StoreOpsWorkspace } from "@/app/ops-pulse/store-ops/workspace";
import { ActivitiesReportClient } from "@/app/ops-pulse/si-handover/report/report-client";
import {
  OpsScreenRuntimeContext,
  type OpsScreenRuntime,
} from "@/components/ops-screen-runtime";
import * as shift from "@/lib/ops-pulse/si-handover/model";
import * as store from "@/lib/ops-pulse/store-ops/model";
import * as shiftReport from "@/lib/ops-pulse/si-handover/report";
import * as storeReport from "@/lib/ops-pulse/store-ops/report";
import {
  activitySeed,
  activityPack,
  sampleActor,
  sampleStores,
  sampleProof,
  newShift,
  newStore,
  type ActivityState,
} from "@/lib/ops-pulse/demo/activities";
const storageKey = "opspulse-production-activities-demo-v1";
const shiftSettings = shift.defaultSettings(),
  storeSettings = store.defaultSettings();
export function ProductionActivities({
  route,
  href,
  navigate,
}: {
  route: string;
  href: (url: string) => string;
  navigate: (url: string) => void;
}) {
  const [state, setState] = useState<ActivityState>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) return JSON.parse(saved);
    } catch {}
    return activitySeed();
  });
  const ref = useRef(state);
  ref.current = state;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {}
  }, [state]);
  useEffect(() => {
    const reset = () => {
      const seed = activitySeed();
      ref.current = seed;
      setState(seed);
      setRevision((n) => n + 1);
    };
    window.addEventListener("opspulse-demo-reset", reset);
    return () => window.removeEventListener("opspulse-demo-reset", reset);
  }, []);
  function commit(next: ActivityState) {
    ref.current = next;
    setState(next);
  }
  function edit(
    kind: "shift" | "store",
    id: string,
    version: number,
    patch: Record<string, unknown>,
  ) {
    const key = kind === "shift" ? "shifts" : "stores";
    const row = ref.current[key].find((r) => r.id === id);
    if (!row || row.version !== version)
      return {
        ok: false as const,
        error: "This sample changed. Open it again.",
      };
    const updated = {
      ...row,
      ...patch,
      version: version + 1,
      updated_at: new Date().toISOString(),
    };
    commit({
      ...ref.current,
      [key]: ref.current[key].map((r) => (r.id === id ? updated : r)),
    } as ActivityState);
    return { ok: true as const, version: version + 1 };
  }
  const runtime: OpsScreenRuntime = {
    href,
    navigate,
    refresh: () => setState({ ...ref.current }),
    mediaUrl: () => "/demo-assets/evidence.svg",
    request: async (input, init) => {
      const url = new URL(String(input), "https://demo.invalid");
      if (url.pathname.endsWith("/picker-headcount"))
        return Response.json({
          fullTime: 12,
          partTime: 4,
          punchedPickers: 16,
          note: "Fictional sample attendance · 12 FT / 4 PT",
        });
      if (url.pathname.endsWith("/report-pack")) {
        const pack = activityPack(
          ref.current,
          url.pathname.includes("/si-handover/") ? "shift" : "store",
          url.searchParams.get("id") || "",
        );
        return Response.json(pack || { error: "Sample report unavailable" }, {
          status: pack ? 200 : 404,
        });
      }
      if (url.pathname.endsWith("/sample-proof")) {
        const { checklistId, taskId } = JSON.parse(String(init?.body || "{}"));
        if (
          ![...ref.current.shifts, ...ref.current.stores].some(
            (r) => r.id === checklistId,
          )
        )
          return Response.json({ error: "Unknown sample" }, { status: 404 });
        const proof = sampleProof(checklistId, taskId);
        commit({ ...ref.current, evidence: [...ref.current.evidence, proof] });
        return Response.json({ proof });
      }
      if (
        url.pathname.endsWith("/upload") &&
        init?.method === "POST" &&
        JSON.parse(String(init.body || "{}")).phase === "delete"
      ) {
        const data = JSON.parse(String(init.body || "{}"));
        commit({
          ...ref.current,
          evidence: ref.current.evidence.filter((p) => p.id !== data.id),
        });
        return Response.json({ ok: true });
      }
      // Never fall back to a live API, even for an unknown feature.
      return Response.json(
        {
          error:
            "This integration is unavailable in the demo. No live request was made.",
        },
        { status: 400 },
      );
    },
    shiftActions: {
      async startShift(input) {
        if (!sampleStores.some((s) => s.id === input.locationId))
          return { ok: false, error: "Choose a sample store." };
        const cur = shift.currentShift(new Date(), shift.DEFAULT_SHIFT_SLOTS);
        const row = newShift(
          input.locationId,
          input.shiftDate || cur.shiftDate,
          (input.shiftSlot || cur.shiftSlot) as shift.ShiftSlot,
        );
        const existing = ref.current.shifts.find(
          (r) => r.id === row.id && !r.deleted_at,
        );
        if (existing) return { ok: true, id: existing.id };
        commit({ ...ref.current, shifts: [row, ...ref.current.shifts] });
        return { ok: true, id: row.id };
      },
      async saveAnswers(input) {
        const row = ref.current.shifts.find((r) => r.id === input.checklistId);
        if (!row || !shift.canFill(sampleActor, shiftSettings, row))
          return { ok: false, error: "This sample is read-only." };
        return edit("shift", input.checklistId, input.version, {
          answers: input.answers,
        });
      },
      async submitHandover(input) {
        const row = ref.current.shifts.find((r) => r.id === input.checklistId);
        if (!row || !shift.canFill(sampleActor, shiftSettings, row))
          return { ok: false, error: "This sample is read-only." };
        try {
          shift.validateAnswersForSubmit(
            row,
            input.answers,
            ref.current.evidence.filter((p) => p.checklist_id === row.id),
            { city: "Sample city", settings: shiftSettings },
          );
        } catch (e) {
          return {
            ok: false,
            error:
              e instanceof Error ? e.message : "Complete the required tasks.",
          };
        }
        const result = edit("shift", row.id, input.version, {
          answers: input.answers,
          status: "submitted",
          submitted_at: new Date().toISOString(),
          open_issues: input.answers.F2?.text || "",
        });
        return result;
      },
      async acceptHandover(input) {
        const row = ref.current.shifts.find((r) => r.id === input.checklistId);
        if (!row || !shift.canAccept(sampleActor, shiftSettings, row))
          return {
            ok: false,
            error: "Open another person's submitted sample to accept.",
          };
        const result = edit("shift", row.id, input.version, {
          status: "accepted",
          accepted_at: new Date().toISOString(),
          accepted_by: sampleActor.userId,
          incoming_name: sampleActor.displayName,
          incoming_user_id: sampleActor.userId,
        });
        return { ...result, nextId: null };
      },
      async rejectHandover(input) {
        const row = ref.current.shifts.find((r) => r.id === input.checklistId);
        if (
          !row ||
          !shift.canAccept(sampleActor, shiftSettings, row) ||
          !input.reason.trim()
        )
          return {
            ok: false,
            error: "Open a submitted sample and add a return reason.",
          };
        return edit("shift", row.id, input.version, {
          status: "rejected",
          rejection: {
            taskIds: input.taskIds,
            reason: input.reason,
            by: sampleActor.userId,
            byName: sampleActor.displayName,
            at: new Date().toISOString(),
          },
        });
      },
      async deleteDraftChecklist(input) {
        const row = ref.current.shifts.find((r) => r.id === input.checklistId);
        if (!row || !shift.canDeleteDraft(sampleActor, shiftSettings, row))
          return {
            ok: false,
            error: "Only an open sample draft can be removed.",
          };
        return edit("shift", input.checklistId, input.version, {
          deleted_at: new Date().toISOString(),
        });
      },
    },
    storeActions: {
      async startDay(input) {
        if (!sampleStores.some((s) => s.id === input.locationId))
          return { ok: false, error: "Choose a sample store." };
        const row = newStore(
            input.locationId,
            input.workDate || store.todayIst(),
          ),
          existing = ref.current.stores.find(
            (r) => r.id === row.id && !r.deleted_at,
          );
        if (existing) return { ok: true, id: existing.id };
        commit({ ...ref.current, stores: [row, ...ref.current.stores] });
        return { ok: true, id: row.id };
      },
      async saveAnswers(input) {
        const row = ref.current.stores.find((r) => r.id === input.checklistId);
        if (!row || !store.canFill(sampleActor, storeSettings, row))
          return { ok: false, error: "This sample is read-only." };
        return edit("store", input.checklistId, input.version, {
          answers: input.answers,
        });
      },
      async submitDay(input) {
        const row = ref.current.stores.find((r) => r.id === input.checklistId);
        if (!row || !store.canFill(sampleActor, storeSettings, row))
          return { ok: false, error: "This sample is read-only." };
        const gaps = store.collectSubmitGaps(
          row,
          input.answers,
          ref.current.evidence.filter((p) => p.checklist_id === row.id),
          {
            city: "Sample city",
            settings: storeSettings,
            weeklyDoneIds: new Set(),
            monthlyDoneIds: new Set(),
          },
        );
        if (gaps.length)
          return { ok: false, error: gaps.slice(0, 3).join(" · ") };
        return edit("store", row.id, input.version, {
          answers: input.answers,
          status: "submitted",
          submitted_at: new Date().toISOString(),
        });
      },
      async deleteDraft(input) {
        const row = ref.current.stores.find((r) => r.id === input.checklistId);
        if (!row || !store.canDeleteDraft(sampleActor, storeSettings, row))
          return {
            ok: false,
            error: "Only an open sample draft can be removed.",
          };
        return edit("store", input.checklistId, input.version, {
          deleted_at: new Date().toISOString(),
        });
      },
    },
  };
  const url = new URL(route, "https://demo.invalid"),
    params = url.searchParams,
    id = params.get("id"),
    today = store.todayIst();
  let body;
  if (url.pathname === "/si-handover/report") {
    const tab = params.get("tab") === "store" ? "store" : "shift",
      from = params.get("from") || today,
      to = params.get("to") || today;
    const sr = shiftReport.enrichChecklistRows(
      state.shifts.filter(
        (r) => !r.deleted_at && r.shift_date >= from && r.shift_date <= to,
      ),
      sampleStores,
      shiftSettings,
    );
    const dr = storeReport.enrichChecklistRows(
      state.stores.filter(
        (r) => !r.deleted_at && r.work_date >= from && r.work_date <= to,
      ),
      sampleStores,
      storeSettings,
    );
    body = (
      <ActivitiesReportClient
        key={`${route}:${revision}`}
        tab={tab}
        from={from}
        to={to}
        showShift
        showStore
        showShiftReport
        showStoreReport
        shift={{
          rows: sr,
          summary: shiftReport.summarizeReport(sr, []),
          stores: sampleStores,
          shiftSlots: shift.DEFAULT_SHIFT_SLOTS,
        }}
        store={{
          rows: dr,
          summary: storeReport.summarizeReport(dr, []),
          stores: sampleStores,
        }}
      />
    );
  } else if (url.pathname === "/store-ops") {
    const focused =
        state.stores.find((r) => r.id === id && !r.deleted_at) || null,
      view = params.get("view") || "start";
    body = (
      <StoreOpsWorkspace
        key={`${route}:${revision}`}
        view={
          (["start", "midday", "compliance", "close"].includes(view)
            ? view
            : "start") as store.WorkspaceView
        }
        stores={sampleStores}
        rows={state.stores.filter((r) => !r.deleted_at)}
        focused={focused}
        evidence={state.evidence.filter((p) => p.checklist_id === id)}
        actor={sampleActor}
        settings={storeSettings}
        error=""
        weeklyDoneIds={[]}
        monthlyDoneIds={[]}
        showShiftOps
        showShiftReport
        showStoreReport
      />
    );
  } else {
    const focused =
        state.shifts.find((r) => r.id === id && !r.deleted_at) || null,
      view = params.get("view") || "start";
    body = (
      <SiHandoverWorkspace
        key={`${route}:${revision}`}
        view={
          (["start", "during", "handover", "accept"].includes(view)
            ? view
            : "start") as shift.WorkspaceView
        }
        stores={sampleStores}
        rows={state.shifts.filter((r) => !r.deleted_at)}
        focused={focused}
        evidence={state.evidence.filter((p) => p.checklist_id === id)}
        actor={sampleActor}
        settings={shiftSettings}
        error=""
        canMaster={false}
        showStoreOps
        showShiftReport
        showStoreReport
      />
    );
  }
  return (
    <OpsScreenRuntimeContext.Provider value={runtime}>
      <div data-ops-screen>{body}</div>
    </OpsScreenRuntimeContext.Provider>
  );
}

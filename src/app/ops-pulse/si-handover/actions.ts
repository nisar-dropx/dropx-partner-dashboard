"use server";

import { revalidatePath } from "next/cache";
import {
  canAccept,
  canFill,
  currentShift,
  emptyAnswer,
  nextShift,
  parseShiftSlot,
  validateAnswersForSubmit,
  validateSettings,
  type ChecklistEvent,
  type Rejection,
  type TaskAnswer,
} from "@/lib/ops-pulse/si-handover/model";
import {
  context,
  db,
  event,
  proofs,
  readChecklist,
  stores,
} from "@/lib/ops-pulse/si-handover/server";

function revalidate() {
  revalidatePath("/ops-pulse/si-handover");
  revalidatePath("/ops-pulse/master/si-handover");
  revalidatePath("/");
}

function fail(e: unknown) {
  return {
    ok: false as const,
    error: e instanceof Error ? e.message : "Something went wrong.",
  };
}

export async function startShift(input: {
  locationId: string;
  shiftDate?: string;
  shiftSlot?: string;
}) {
  try {
    const c = await context(true);
    if (!c.actor.permissions.si_handover?.canAdd && !c.actor.permissions.si_handover?.canEdit)
      throw Error("You do not have permission to start a shift checklist.");
    const locations = await stores(c.auth, c.master.settings);
    const store = locations.find((l) => l.id === input.locationId);
    if (!store) throw Error("Store not in your Dark Store scope.");
    const cur = currentShift(new Date(), c.master.settings.shiftSlots);
    const shiftDate = input.shiftDate || cur.shiftDate;
    const shiftSlot = parseShiftSlot(input.shiftSlot || cur.shiftSlot);

    const existing = await db()
      .from("ops_si_shift_checklists")
      .select("*")
      .eq("company_id", c.companyId)
      .eq("location_id", store.id)
      .eq("shift_date", shiftDate)
      .eq("shift_slot", shiftSlot)
      .is("deleted_at", null)
      .neq("status", "cancelled")
      .maybeSingle();
    if (existing.error) throw Error(existing.error.message);
    if (existing.data) {
      if (
        existing.data.outgoing_user_id !== c.actor.userId &&
        existing.data.status !== "accepted"
      )
        throw Error(
          `This shift is already owned by ${existing.data.outgoing_name}. Ask them to hand over, or open Acceptance if they have submitted.`,
        );
      revalidate();
      return { ok: true as const, id: existing.data.id as string };
    }

    const row = {
      company_id: c.companyId,
      location_id: store.id,
      store_code: store.station_code,
      store_name: store.station_name || store.station_code,
      shift_date: shiftDate,
      shift_slot: shiftSlot,
      status: "open",
      template: c.master.template,
      template_version: c.master.version,
      answers: {},
      open_issues: "",
      events: [event(c.actor, "started", "Shift checklist opened")],
      outgoing_user_id: c.actor.userId,
      outgoing_name: c.actor.displayName,
      started_at: new Date().toISOString(),
    };
    const inserted = await db()
      .from("ops_si_shift_checklists")
      .insert(row)
      .select("id")
      .single();
    if (inserted.error) throw Error(inserted.error.message);
    revalidate();
    return { ok: true as const, id: inserted.data.id as string };
  } catch (e) {
    return fail(e);
  }
}

export async function saveAnswers(input: {
  checklistId: string;
  version: number;
  answers: Record<string, TaskAnswer>;
  openIssues?: string;
}) {
  try {
    const c = await readChecklist(input.checklistId);
    if (!canFill(c.actor, c.master.settings, c.checklist))
      throw Error("This checklist is not editable.");
    if (c.checklist.version !== input.version)
      throw Error("Someone else updated this checklist. Refresh and try again.");
    const answers = { ...c.checklist.answers };
    for (const [id, value] of Object.entries(input.answers || {})) {
      answers[id] = {
        ...emptyAnswer(),
        ...value,
        numbers: value.numbers || {},
        answeredAt: new Date().toISOString(),
      };
    }
    const events = [
      ...c.checklist.events,
      event(c.actor, "draft_saved", "Answers saved"),
    ].slice(-80);
    const patch: Record<string, unknown> = {
      answers,
      events,
      version: c.checklist.version + 1,
      open_issues:
        input.openIssues !== undefined
          ? input.openIssues
          : answers.F2?.text || c.checklist.open_issues,
    };
    const r = await db()
      .from("ops_si_shift_checklists")
      .update(patch)
      .eq("company_id", c.companyId)
      .eq("id", c.checklist.id)
      .eq("version", input.version)
      .select("id,version")
      .maybeSingle();
    if (r.error) throw Error(r.error.message);
    if (!r.data) throw Error("Save conflict. Refresh and try again.");
    revalidate();
    return { ok: true as const, version: r.data.version as number };
  } catch (e) {
    return fail(e);
  }
}

export async function submitHandover(input: {
  checklistId: string;
  version: number;
  answers: Record<string, TaskAnswer>;
}) {
  try {
    const c = await readChecklist(input.checklistId);
    if (!canFill(c.actor, c.master.settings, c.checklist))
      throw Error("Only the outgoing Shift Incharge can submit handover.");
    if (c.checklist.version !== input.version)
      throw Error("Someone else updated this checklist. Refresh and try again.");
    const locations = await stores(c.auth, c.master.settings);
    const store = locations.find((l) => l.id === c.checklist.location_id);
    const answers = { ...c.checklist.answers };
    for (const [id, value] of Object.entries(input.answers || {})) {
      answers[id] = {
        ...emptyAnswer(),
        ...value,
        numbers: value.numbers || {},
        answeredAt: new Date().toISOString(),
      };
    }
    const evidence = await proofs(c.companyId, c.checklist.id);
    validateAnswersForSubmit(c.checklist, answers, evidence, {
      city: store?.city,
      settings: c.master.settings,
    });
    const openIssues = answers.F2?.text?.trim() || "";
    const events = [
      ...c.checklist.events,
      event(c.actor, "submitted", "Handover submitted for acceptance"),
    ].slice(-80);
    const r = await db()
      .from("ops_si_shift_checklists")
      .update({
        answers,
        open_issues: openIssues,
        status: "submitted",
        submitted_at: new Date().toISOString(),
        rejected_at: null,
        rejected_by: null,
        rejection: null,
        events,
        version: c.checklist.version + 1,
      })
      .eq("company_id", c.companyId)
      .eq("id", c.checklist.id)
      .eq("version", input.version)
      .in("status", ["open", "rejected"])
      .select("id")
      .maybeSingle();
    if (r.error) throw Error(r.error.message);
    if (!r.data) throw Error("Submit conflict. Refresh and try again.");
    revalidate();
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function acceptHandover(input: { checklistId: string; version: number }) {
  try {
    const c = await readChecklist(input.checklistId);
    if (!canAccept(c.actor, c.master.settings, c.checklist))
      throw Error(
        "Incoming Shift Incharge must review and accept. You cannot accept your own handover.",
      );
    if (c.checklist.version !== input.version)
      throw Error("Someone else updated this checklist. Refresh and try again.");

    const events: ChecklistEvent[] = [
      ...c.checklist.events,
      event(c.actor, "accepted", "Handover accepted; next shift opened"),
    ].slice(-80);

    const accepted = await db()
      .from("ops_si_shift_checklists")
      .update({
        status: "accepted",
        accepted_at: new Date().toISOString(),
        accepted_by: c.actor.userId,
        incoming_user_id: c.actor.userId,
        incoming_name: c.actor.displayName,
        events,
        version: c.checklist.version + 1,
      })
      .eq("company_id", c.companyId)
      .eq("id", c.checklist.id)
      .eq("version", input.version)
      .eq("status", "submitted")
      .select("*")
      .maybeSingle();
    if (accepted.error) throw Error(accepted.error.message);
    if (!accepted.data) throw Error("Accept conflict. Refresh and try again.");

    const nxt = nextShift(
      c.checklist.shift_date,
      c.checklist.shift_slot,
      c.master.settings.shiftSlots,
    );
    const locations = await stores(c.auth, c.master.settings);
    const store = locations.find((l) => l.id === c.checklist.location_id);
    if (!store) {
      revalidate();
      return { ok: true as const, nextId: null as string | null };
    }

    const existingNext = await db()
      .from("ops_si_shift_checklists")
      .select("id,outgoing_user_id,status")
      .eq("company_id", c.companyId)
      .eq("location_id", store.id)
      .eq("shift_date", nxt.shiftDate)
      .eq("shift_slot", nxt.shiftSlot)
      .is("deleted_at", null)
      .neq("status", "cancelled")
      .maybeSingle();
    if (existingNext.error) throw Error(existingNext.error.message);

    let nextId = existingNext.data?.id as string | undefined;
    if (!existingNext.data) {
      const inserted = await db()
        .from("ops_si_shift_checklists")
        .insert({
          company_id: c.companyId,
          location_id: store.id,
          store_code: store.station_code,
          store_name: store.station_name || store.station_code,
          shift_date: nxt.shiftDate,
          shift_slot: nxt.shiftSlot,
          status: "open",
          template: c.master.template,
          template_version: c.master.version,
          answers: {},
          open_issues: c.checklist.open_issues,
          events: [
            event(
              c.actor,
              "started",
              `Opened after accepting ${c.checklist.shift_date} ${c.checklist.shift_slot}`,
            ),
          ],
          outgoing_user_id: c.actor.userId,
          outgoing_name: c.actor.displayName,
          started_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (inserted.error) throw Error(inserted.error.message);
      nextId = inserted.data.id;
    } else if (existingNext.data.status === "open") {
      const prior = await db()
        .from("ops_si_shift_checklists")
        .select("events,open_issues")
        .eq("id", existingNext.data.id)
        .eq("company_id", c.companyId)
        .single();
      const priorEvents = (prior.data?.events || []) as ChecklistEvent[];
      const patch: Record<string, unknown> = {
        open_issues: c.checklist.open_issues || prior.data?.open_issues || "",
        events: [
          ...priorEvents,
          event(
            c.actor,
            "prior_issues",
            "Open issues imported from accepted handover",
          ),
        ].slice(-80),
      };
      if (existingNext.data.outgoing_user_id !== c.actor.userId) {
        patch.outgoing_user_id = c.actor.userId;
        patch.outgoing_name = c.actor.displayName;
      }
      await db()
        .from("ops_si_shift_checklists")
        .update(patch)
        .eq("id", existingNext.data.id)
        .eq("company_id", c.companyId);
    }

    revalidate();
    return { ok: true as const, nextId: nextId || null };
  } catch (e) {
    return fail(e);
  }
}

export async function rejectHandover(input: {
  checklistId: string;
  version: number;
  taskIds: string[];
  reason: string;
}) {
  try {
    const c = await readChecklist(input.checklistId);
    if (!canAccept(c.actor, c.master.settings, c.checklist))
      throw Error("Only the incoming Shift Incharge can reject a handover.");
    if (!input.reason?.trim()) throw Error("Add a rejection reason.");
    if (c.checklist.version !== input.version)
      throw Error("Someone else updated this checklist. Refresh and try again.");
    const rejection: Rejection = {
      taskIds: input.taskIds || [],
      reason: input.reason.trim(),
      by: c.actor.userId,
      byName: c.actor.displayName,
      at: new Date().toISOString(),
    };
    const events = [
      ...c.checklist.events,
      event(
        c.actor,
        "rejected",
        rejection.reason +
          (rejection.taskIds.length
            ? ` · items: ${rejection.taskIds.join(", ")}`
            : ""),
      ),
    ].slice(-80);
    const r = await db()
      .from("ops_si_shift_checklists")
      .update({
        status: "rejected",
        rejection,
        rejected_at: rejection.at,
        rejected_by: c.actor.userId,
        submitted_at: c.checklist.submitted_at,
        events,
        version: c.checklist.version + 1,
      })
      .eq("company_id", c.companyId)
      .eq("id", c.checklist.id)
      .eq("version", input.version)
      .eq("status", "submitted")
      .select("id")
      .maybeSingle();
    if (r.error) throw Error(r.error.message);
    if (!r.data) throw Error("Reject conflict. Refresh and try again.");
    revalidate();
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function saveSiHandoverMaster(input: {
  version: number;
  template: unknown;
  settings: unknown;
}) {
  try {
    const c = await context(true, true);
    if (c.master.version !== input.version)
      throw Error("Master was updated elsewhere. Refresh and try again.");
    const settings = validateSettings(input.settings as never);
    const template = input.template as typeof c.master.template;
    if (!template?.name?.trim() || !Array.isArray(template.sections))
      throw Error("Template needs a name and sections.");
    const r = await db()
      .from("ops_si_handover_master")
      .update({
        template,
        settings,
        version: c.master.version + 1,
        updated_by: c.actor.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("company_id", c.companyId)
      .eq("version", input.version)
      .select("version")
      .maybeSingle();
    if (r.error) throw Error(r.error.message);
    if (!r.data) throw Error("Save conflict. Refresh and try again.");
    revalidate();
    return { ok: true as const, version: r.data.version as number };
  } catch (e) {
    return fail(e);
  }
}

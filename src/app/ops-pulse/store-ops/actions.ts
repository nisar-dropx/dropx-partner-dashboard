"use server";

import { revalidatePath } from "next/cache";
import {
  canDeleteDraft,
  canFill,
  isFiller,
  normalizeAnswer,
  normalizeSettings,
  todayIst,
  validateForSubmit,
  type Settings,
  type TaskAnswer,
  type Template,
} from "@/lib/ops-pulse/store-ops/model";
import {
  context,
  db,
  event,
  periodCompletions,
  proofs,
  readChecklist,
  stores,
} from "@/lib/ops-pulse/store-ops/server";

function revalidate() {
  revalidatePath("/ops-pulse/store-ops");
  revalidatePath("/store-ops");
  revalidatePath("/master/store-ops");
  revalidatePath("/si-handover/report");
  revalidatePath("/");
}

function fail(e: unknown) {
  return {
    ok: false as const,
    error: e instanceof Error ? e.message : "Request failed.",
  };
}

export async function startDay(input: {
  locationId: string;
  workDate?: string;
}) {
  try {
    const c = await context(true);
    if (!isFiller(c.actor, c.master.settings) && !c.actor.isMasterOwner)
      throw Error("Only Store Manager / Store In-charge can start the day.");
    const locations = await stores(c.auth, c.master.settings);
    const store = locations.find((l) => l.id === input.locationId);
    if (!store) throw Error("Store is outside your scope.");
    const workDate = input.workDate || todayIst();
    const existing = await db()
      .from("ops_store_ops_checklists")
      .select("id")
      .eq("company_id", c.companyId)
      .eq("location_id", store.id)
      .eq("work_date", workDate)
      .is("deleted_at", null)
      .neq("status", "cancelled")
      .maybeSingle();
    if (existing.error) throw Error(existing.error.message);
    if (existing.data)
      return { ok: true as const, id: existing.data.id as string };

    const r = await db()
      .from("ops_store_ops_checklists")
      .insert({
        company_id: c.companyId,
        location_id: store.id,
        store_code: store.station_code,
        store_name: store.station_name || store.station_code,
        work_date: workDate,
        status: "open",
        template: c.master.template,
        template_version: c.master.version,
        answers: {},
        day_summary: "",
        events: [
          event(c.actor, "started", "Store operations day checklist opened"),
        ],
        owner_user_id: c.actor.userId,
        owner_name: c.actor.displayName,
      })
      .select("id")
      .single();
    if (r.error) throw Error(r.error.message);
    revalidate();
    return { ok: true as const, id: r.data.id as string };
  } catch (e) {
    return fail(e);
  }
}

export async function saveAnswers(input: {
  checklistId: string;
  version: number;
  answers: Record<string, TaskAnswer>;
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
        ...normalizeAnswer(value),
        answeredAt: new Date().toISOString(),
      };
    }
    const daySummary = answers.M19?.text?.trim() || c.checklist.day_summary;
    const events = [
      ...c.checklist.events,
      event(c.actor, "draft_saved", "Answers saved"),
    ].slice(-80);
    const r = await db()
      .from("ops_store_ops_checklists")
      .update({
        answers,
        day_summary: daySummary,
        events,
        version: c.checklist.version + 1,
        updated_at: new Date().toISOString(),
      })
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

export async function submitDay(input: {
  checklistId: string;
  version: number;
  answers: Record<string, TaskAnswer>;
}) {
  try {
    const c = await readChecklist(input.checklistId);
    if (!canFill(c.actor, c.master.settings, c.checklist))
      throw Error("Only Store Manager / Store In-charge can submit.");
    if (c.checklist.version !== input.version)
      throw Error("Someone else updated this checklist. Refresh and try again.");
    const locations = await stores(c.auth, c.master.settings);
    const store = locations.find((l) => l.id === c.checklist.location_id);
    const answers = { ...c.checklist.answers };
    for (const [id, value] of Object.entries(input.answers || {})) {
      answers[id] = {
        ...normalizeAnswer(value),
        answeredAt: new Date().toISOString(),
      };
    }
    const evidence = await proofs(c.companyId, c.checklist.id);
    const period = await periodCompletions(
      c.companyId,
      c.checklist.location_id,
      c.checklist.work_date,
      c.checklist.id,
    );
    validateForSubmit(c.checklist, answers, evidence, {
      city: store?.city,
      settings: c.master.settings,
      weeklyDoneIds: period.weeklyDone,
      monthlyDoneIds: period.monthlyDone,
    });
    const events = [
      ...c.checklist.events,
      event(c.actor, "submitted", "Day checklist submitted"),
    ].slice(-80);
    const r = await db()
      .from("ops_store_ops_checklists")
      .update({
        answers,
        day_summary: answers.M19?.text?.trim() || "",
        status: "submitted",
        submitted_at: new Date().toISOString(),
        events,
        version: c.checklist.version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("company_id", c.companyId)
      .eq("id", c.checklist.id)
      .eq("version", input.version)
      .eq("status", "open")
      .select("id,version")
      .maybeSingle();
    if (r.error) throw Error(r.error.message);
    if (!r.data) throw Error("Submit conflict. Refresh and try again.");
    revalidate();
    return { ok: true as const, version: r.data.version as number };
  } catch (e) {
    return fail(e);
  }
}

export async function saveStoreOpsMaster(input: {
  version: number;
  template: Template;
  settings: Settings;
}) {
  try {
    const c = await context(true, true);
    if (c.master.version !== input.version)
      throw Error("Master was updated elsewhere. Refresh and try again.");
    const settings = normalizeSettings(input.settings);
    const template = input.template;
    if (!template?.name?.trim() || !Array.isArray(template.sections))
      throw Error("Template needs a name and sections.");
    const r = await db()
      .from("ops_store_ops_master")
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

export async function deleteDraft(input: { checklistId: string; version: number }) {
  try {
    const c = await readChecklist(input.checklistId);
    if (!canDeleteDraft(c.actor, c.master.settings, c.checklist))
      throw Error(
        "Only an open draft can be deleted, by its owner, a programme manager, or a company owner.",
      );
    const r = await db()
      .from("ops_store_ops_checklists")
      .update({
        status: "cancelled",
        deleted_at: new Date().toISOString(),
        version: c.checklist.version + 1,
        updated_at: new Date().toISOString(),
        events: [
          ...c.checklist.events,
          event(c.actor, "cancelled", "Draft cancelled"),
        ].slice(-80),
      })
      .eq("company_id", c.companyId)
      .eq("id", c.checklist.id)
      .eq("version", input.version)
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    if (r.error) throw Error(r.error.message);
    if (!r.data) throw Error("Delete conflict. Refresh and try again.");
    revalidate();
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

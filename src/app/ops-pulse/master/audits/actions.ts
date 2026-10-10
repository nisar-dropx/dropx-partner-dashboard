"use server";

import { validAuditRecipientRule } from "@/lib/ops-pulse/station-audit-recipients";
import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Result = { ok: true; message: string } | { ok: false; message: string };
const clean = (value: FormDataEntryValue | null | undefined) =>
  String(value ?? "").trim();
function db() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}
function result(error: unknown): Result {
  return {
    ok: false,
    message:
      error instanceof Error ? error.message : "Unable to update Audit Master.",
  };
}
function refresh() {
  revalidatePath("/ops-pulse/master/audits");
  revalidatePath("/master/audits");
  revalidatePath("/ops-pulse/audits");
  revalidatePath("/audits");
}
function jsonObject(value: string, label: string) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON object.`);
  }
}
function jsonArray(value: string, label: string) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON array.`);
  }
}
function scoreWeight(value: FormDataEntryValue | null, fallback = 1) {
  const n = value == null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100)
    throw new Error("Score weight must be from 0 to 100.");
  return n;
}
function scoredOptions(value: string) {
  const options = jsonArray(value, "Response options");
  const keys = new Set<string>();
  for (const o of options) {
    if (
      !o ||
      typeof o !== "object" ||
      !String(o.value || "").trim() ||
      keys.has(o.value)
    )
      throw new Error("Each response needs a unique value and label.");
    keys.add(o.value);
    if (
      o.score != null &&
      (typeof o.score !== "number" ||
        !Number.isFinite(o.score) ||
        o.score < 0 ||
        o.score > 100)
    )
      throw new Error("Outcome scores must be from 0 to 100, or null for N/A.");
  }
  return options;
}
function scoreSource(value: FormDataEntryValue | null) {
  const source = clean(value) || "checklist";
  if (!["checklist", "cash_match", "shipment_match"].includes(source))
    throw new Error("Invalid scoring source.");
  return source;
}
function selectedValues(formData: FormData, key: string) {
  return Array.from(
    new Set(
      formData
        .getAll(key)
        .map((value) => clean(value))
        .filter(Boolean),
    ),
  );
}

async function access() {
  const authorization = await requirePagePermission(
    "station_audit_master",
    "edit",
  );
  return { authorization, companyId: requireCompanyId(authorization) };
}

async function validateChecklistParent(
  companyId: string,
  typeId: string,
  sectionId?: string,
) {
  const type = await db()
    .from("ops_audit_types")
    .select("id")
    .eq("company_id", companyId)
    .eq("id", typeId)
    .maybeSingle();
  if (type.error || !type.data)
    throw new Error("Choose an audit type from your company.");
  if (sectionId) {
    const section = await db()
      .from("ops_audit_checklist_sections")
      .select("id")
      .eq("company_id", companyId)
      .eq("audit_type_id", typeId)
      .eq("id", sectionId)
      .maybeSingle();
    if (section.error || !section.data)
      throw new Error("Choose a section from this audit type.");
  }
}

export async function saveAuditProgrammeSettings(
  formData: FormData,
): Promise<Result> {
  try {
    const { authorization, companyId } = await access();
    const payload = {
      company_id: companyId,
      scheduler_role_ids: selectedValues(formData, "scheduler_role_ids"),
      responder_role_ids: selectedValues(formData, "responder_role_ids"),
      excluded_location_model_ids: selectedValues(
        formData,
        "excluded_location_model_ids",
      ),
      excluded_location_ids: selectedValues(formData, "excluded_location_ids"),
      exclude_head_office: clean(formData.get("exclude_head_office")) === "yes",
      updated_by: authorization.userId,
    };
    if (!payload.scheduler_role_ids.length)
      throw new Error(
        "Select at least one manager role that can schedule and run audits.",
      );
    if (!payload.responder_role_ids.length)
      throw new Error(
        "Select at least one station role that can respond to open audit actions.",
      );
    const saved = await db()
      .from("ops_audit_programme_settings")
      .upsert(payload, { onConflict: "company_id" });
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Audit access and station scope updated." };
  } catch (error) {
    return result(error);
  }
}

export async function saveAuditType(formData: FormData): Promise<Result> {
  try {
    const { authorization, companyId } = await access();
    const id = clean(formData.get("id"));
    const payload = {
      name: clean(formData.get("name")),
      description: clean(formData.get("description")) || null,
      cadence_unit: clean(formData.get("cadence_unit")),
      required_count: Number(clean(formData.get("required_count"))),
      scheduling_config: jsonObject(
        clean(formData.get("scheduling_config")),
        "Scheduling configuration",
      ),
      default_response_hours: Number(
        clean(formData.get("default_response_hours")),
      ),
      expected_duration_minutes:
        Number(clean(formData.get("expected_duration_minutes"))) || null,
      scoring_enabled: clean(formData.get("scoring_enabled")) === "yes",
      requires_video_link: clean(formData.get("requires_video_link")) === "yes",
      shipment_reconciliation_enabled:
        clean(formData.get("shipment_reconciliation_enabled")) === "yes",
      video_link_help: clean(formData.get("video_link_help")) || null,
      recipient_rules: jsonArray(
        clean(formData.get("recipient_rules")),
        "Recipient rules",
      ),
      cc_rules: jsonArray(clean(formData.get("cc_rules")), "CC rules"),
      email_subject_template:
        clean(formData.get("email_subject_template")) || null,
      email_body_template: clean(formData.get("email_body_template")) || null,
      is_active: clean(formData.get("is_active")) === "yes",
      updated_by: authorization.userId,
    };
    if (
      ![...payload.recipient_rules, ...payload.cc_rules].every(
        validAuditRecipientRule,
      )
    )
      throw new Error("Choose recipients from the Audit Master directory.");
    if (
      !payload.name ||
      !payload.cadence_unit ||
      !Number.isInteger(payload.required_count) ||
      payload.required_count < 1 ||
      !Number.isInteger(payload.default_response_hours) ||
      payload.default_response_hours < 0
    )
      throw new Error(
        "Complete the name, cadence, required count and response hours.",
      );
    const saved = await db()
      .from("ops_audit_types")
      .update(payload)
      .eq("company_id", companyId)
      .eq("id", id);
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Audit programme updated." };
  } catch (error) {
    return result(error);
  }
}

export async function createAuditType(formData: FormData): Promise<Result> {
  try {
    const { authorization, companyId } = await access();
    const code = clean(formData.get("code"))
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    const name = clean(formData.get("name"));
    if (!code || !name) throw new Error("Enter an audit code and name.");
    const saved = await db()
      .from("ops_audit_types")
      .insert({
        company_id: companyId,
        code,
        name,
        cadence_unit: clean(formData.get("cadence_unit")) || "monthly",
        required_count: Number(clean(formData.get("required_count"))) || 1,
        scheduling_config: jsonObject(
          clean(formData.get("scheduling_config")),
          "Scheduling configuration",
        ),
        default_response_hours:
          Number(clean(formData.get("default_response_hours"))) || 72,
        created_by: authorization.userId,
        updated_by: authorization.userId,
      });
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Audit type added." };
  } catch (error) {
    return result(error);
  }
}

export async function createAuditSection(formData: FormData): Promise<Result> {
  try {
    const { companyId } = await access();
    const auditTypeId = clean(formData.get("audit_type_id"));
    const code = clean(formData.get("code"))
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    const name = clean(formData.get("name"));
    if (!auditTypeId || !code || !name)
      throw new Error(
        "Select an audit type and enter a section code and name.",
      );
    await validateChecklistParent(companyId, auditTypeId);
    const saved = await db()
      .from("ops_audit_checklist_sections")
      .insert({
        company_id: companyId,
        audit_type_id: auditTypeId,
        code,
        name,
        guidance: clean(formData.get("guidance")) || null,
        score_weight: scoreWeight(formData.get("score_weight"), 0),
        sort_order: Number(clean(formData.get("sort_order"))) || 0,
      });
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Checklist section added." };
  } catch (error) {
    return result(error);
  }
}

export async function saveAuditSection(formData: FormData): Promise<Result> {
  try {
    const { companyId } = await access();
    const id = clean(formData.get("id")),
      name = clean(formData.get("name"));
    if (!name) throw new Error("Enter the section name.");
    const saved = await db()
      .from("ops_audit_checklist_sections")
      .update({
        name,
        guidance: clean(formData.get("guidance")),
        score_weight: scoreWeight(formData.get("score_weight"), 0),
        sort_order: Number(formData.get("sort_order")) || 0,
      })
      .eq("company_id", companyId)
      .eq("id", id);
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return {
      ok: true,
      message:
        "Section and score weight updated. Saved reports retain their original scoring.",
    };
  } catch (error) {
    return result(error);
  }
}

export async function saveChecklistItem(formData: FormData): Promise<Result> {
  try {
    const { companyId } = await access();
    const id = clean(formData.get("id"));
    const payload = {
      label: clean(formData.get("label")),
      guidance: clean(formData.get("guidance")) || null,
      score_weight: scoreWeight(formData.get("score_weight")),
      score_source: scoreSource(formData.get("score_source")),
      response_type: clean(formData.get("response_type")),
      response_options: scoredOptions(clean(formData.get("response_options"))),
      is_required: clean(formData.get("is_required")) === "yes",
      photo_required: clean(formData.get("photo_required")) === "yes",
      photo_on_non_compliance:
        clean(formData.get("photo_on_non_compliance")) === "yes",
      remarks_required: clean(formData.get("remarks_required")) === "yes",
      employee_selection: ["single", "multiple"].includes(
        clean(formData.get("employee_selection")),
      )
        ? clean(formData.get("employee_selection"))
        : "none",
      evidence_rule: clean(formData.get("evidence_rule")),
      action_rule: clean(formData.get("action_rule")),
      default_severity_code:
        clean(formData.get("default_severity_code")) || null,
      sort_order: Number(clean(formData.get("sort_order"))) || 0,
      is_active: clean(formData.get("is_active")) === "yes",
    };
    if (
      !payload.label ||
      !payload.response_type ||
      !payload.evidence_rule ||
      !payload.action_rule
    )
      throw new Error("Checklist label, response type and rules are required.");
    const saved = await db()
      .from("ops_audit_checklist_items")
      .update(payload)
      .eq("company_id", companyId)
      .eq("id", id);
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Checklist item updated." };
  } catch (error) {
    return result(error);
  }
}

export async function createChecklistItem(formData: FormData): Promise<Result> {
  try {
    const { companyId } = await access();
    const auditTypeId = clean(formData.get("audit_type_id"));
    const code = clean(formData.get("code"))
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    const label = clean(formData.get("label"));
    if (!auditTypeId || !code || !label)
      throw new Error("Choose an audit type and enter an item code and label.");
    if (!clean(formData.get("section_id")))
      throw new Error(
        "Select a checklist section so the check can be displayed.",
      );
    await validateChecklistParent(
      companyId,
      auditTypeId,
      clean(formData.get("section_id")),
    );
    const saved = await db()
      .from("ops_audit_checklist_items")
      .insert({
        company_id: companyId,
        audit_type_id: auditTypeId,
        section_id: clean(formData.get("section_id")) || null,
        code,
        label,
        guidance: clean(formData.get("guidance")) || null,
        score_weight: scoreWeight(formData.get("score_weight")),
        score_source: scoreSource(formData.get("score_source")),
        response_type: clean(formData.get("response_type")) || "pass_fail_na",
        response_options: scoredOptions(
          clean(formData.get("response_options")),
        ),
        is_required: clean(formData.get("is_required")) === "yes",
        photo_required: clean(formData.get("photo_required")) === "yes",
        photo_on_non_compliance:
          clean(formData.get("photo_on_non_compliance")) === "yes",
        remarks_required: clean(formData.get("remarks_required")) === "yes",
        employee_selection: ["single", "multiple"].includes(
          clean(formData.get("employee_selection")),
        )
          ? clean(formData.get("employee_selection"))
          : "none",
        evidence_rule:
          clean(formData.get("evidence_rule")) || "on_non_compliance",
        action_rule: clean(formData.get("action_rule")) || "on_non_compliance",
        default_severity_code:
          clean(formData.get("default_severity_code")) || null,
        sort_order: Number(clean(formData.get("sort_order"))) || 0,
      });
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Checklist item added." };
  } catch (error) {
    return result(error);
  }
}

export async function saveAuditOption(formData: FormData): Promise<Result> {
  try {
    const { companyId } = await access();
    const id = clean(formData.get("id"));
    const payload = {
      label: clean(formData.get("label")),
      description: clean(formData.get("description")) || null,
      metadata: jsonObject(clean(formData.get("metadata")), "Option metadata"),
      sort_order: Number(clean(formData.get("sort_order"))) || 0,
      is_active: clean(formData.get("is_active")) === "yes",
    };
    if (!payload.label) throw new Error("Option label is required.");
    const saved = await db()
      .from("ops_audit_reference_options")
      .update(payload)
      .eq("company_id", companyId)
      .eq("id", id);
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Reference value updated." };
  } catch (error) {
    return result(error);
  }
}

export async function createAuditOption(formData: FormData): Promise<Result> {
  try {
    const { companyId } = await access();
    const optionGroup = clean(formData.get("option_group"))
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    const code = clean(formData.get("code"))
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    const label = clean(formData.get("label"));
    if (!optionGroup || !code || !label)
      throw new Error("Enter option group, code and label.");
    const saved = await db()
      .from("ops_audit_reference_options")
      .insert({
        company_id: companyId,
        option_group: optionGroup,
        code,
        label,
        description: clean(formData.get("description")) || null,
        metadata: jsonObject(
          clean(formData.get("metadata")),
          "Option metadata",
        ),
        sort_order: Number(clean(formData.get("sort_order"))) || 0,
      });
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Reference value added." };
  } catch (error) {
    return result(error);
  }
}

export async function saveAuditAirways(formData: FormData): Promise<Result> {
  try {
    const { authorization, companyId } = await access();
    const label = clean(formData.get("label"));
    const id = clean(formData.get("id"));
    const stationIds = selectedValues(formData, "station_ids");
    if (!label || label.length > 80)
      throw new Error("Enter an Airways name of up to 80 characters.");
    const { loadAuditStations, loadStationAuditMaster } = await import(
      "@/lib/ops-pulse/station-audits"
    );
    const master = await loadStationAuditMaster(companyId);
    const stations = await loadAuditStations(
      companyId,
      authorization,
      master.programmeSettings,
    );
    const authorized = new Set(stations.map((station) => station.id));
    if (stationIds.some((stationId) => !authorized.has(stationId)))
      throw new Error("One or more stations are outside your audit scope.");
    const existing = master.options.find(
      (option) => option.id === id && option.option_group === "airways",
    );
    if (id && !existing)
      throw new Error("Airways entry unavailable. Refresh and try again.");
    // Preserve assignments outside a scoped editor's locations.
    const preserved = Array.isArray(existing?.metadata.station_ids)
      ? existing.metadata.station_ids.filter(
          (stationId) =>
            typeof stationId === "string" && !authorized.has(stationId),
        )
      : [];
    const payload = {
      label,
      metadata: {
        ...existing?.metadata,
        station_ids: [...preserved, ...stationIds],
      },
    };
    const saved = id
      ? await db()
          .from("ops_audit_reference_options")
          .update(payload)
          .eq("company_id", companyId)
          .eq("option_group", "airways")
          .eq("id", id)
      : await db()
          .from("ops_audit_reference_options")
          .insert({
            ...payload,
            company_id: companyId,
            option_group: "airways",
            code: crypto.randomUUID(),
            is_active: true,
          });
    if (saved.error) throw new Error(saved.error.message);
    refresh();
    return { ok: true, message: "Airways and station mappings saved." };
  } catch (error) {
    return result(error);
  }
}

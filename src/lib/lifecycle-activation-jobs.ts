import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

type ProfileType = "employee" | "contractor" | "workforce";

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function normalizePan(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** HO employees + Last Mile EDSP workforce; Amazon Now / ODH / Flipkart stay out of Marsh. */
export function marshInScope(input: {
  profileType: ProfileType;
  stationCode?: string | null;
  partnerCode?: string | null;
  channel?: string | null;
}) {
  const partner = `${input.partnerCode || ""} ${input.channel || ""} ${input.stationCode || ""}`.toUpperCase();
  if (/AMAZON\s*NOW|ODH|FLIPKART/.test(partner)) return false;
  if (input.profileType === "employee") return true;
  if (input.profileType === "workforce" || input.profileType === "contractor") {
    return !/NOW|ODH/.test(partner);
  }
  return false;
}

export function idfyRequiredForRole(input: {
  designationCode?: string | null;
  designationName?: string | null;
  isDeliveryAssociate?: boolean;
}) {
  if (input.isDeliveryAssociate) return false;
  const blob = `${input.designationCode || ""} ${input.designationName || ""}`.toUpperCase();
  if (/\bDA\b|DELIVERY\s*ASSOCIATE|AMAZON\s*DA/.test(blob)) return false;
  return true;
}

/**
 * Queue Marsh + IDfy activation jobs directly in Supabase.
 * Prefer this over the Workforce-worker HTTP hop so a missing admin key cannot silently skip enroll.
 */
export async function enqueueActivationJobsDirect(input: {
  companyId: string;
  profileType: ProfileType;
  profileId: string;
  pan?: string | null;
  email?: string | null;
  fullName?: string | null;
  designation?: string | null;
  designationCode?: string | null;
  stationCode?: string | null;
  partnerCode?: string | null;
  channel?: string | null;
  isDeliveryAssociate?: boolean;
  accountKey?: "edsp" | "now";
  payload: Record<string, unknown>;
  hasDrivingLicence?: boolean;
  drivingLicenseNo?: string | null;
  dlFrontPath?: string | null;
  dlBackPath?: string | null;
}): Promise<{
  marsh: { enqueued: string[]; skipped: string[] };
  idfy: { enqueued: boolean; skipped?: string };
}> {
  if (!supabaseAdmin) {
    throw new Error("Database service is unavailable for activation automation.");
  }

  const marsh = { enqueued: [] as string[], skipped: [] as string[] };
  const pan = normalizePan(input.pan);

  if (!pan) {
    marsh.skipped.push("missing_pan");
  } else if (!PAN_RE.test(pan)) {
    marsh.skipped.push("invalid_pan");
  } else if (
    !marshInScope({
      profileType: input.profileType,
      stationCode: input.stationCode,
      partnerCode: input.partnerCode,
      channel: input.channel
    })
  ) {
    marsh.skipped.push("out_of_scope");
  } else {
    for (const policyType of ["GMC", "GPA"] as const) {
      const { data: membership } = await supabaseAdmin
        .from("insurance_memberships")
        .select("status")
        .eq("company_id", input.companyId)
        .eq("pan", pan)
        .eq("policy_type", policyType)
        .maybeSingle();
      if (membership && /active/i.test(String(membership.status || ""))) {
        marsh.skipped.push(`${policyType}:already_active`);
        continue;
      }
      const { error } = await supabaseAdmin.from("insurance_enroll_jobs").insert({
        company_id: input.companyId,
        pan,
        policy_type: policyType,
        profile_type: input.profileType,
        profile_id: input.profileId,
        payload: input.payload,
        status: "queued"
      });
      if (error) {
        if (/duplicate|unique/i.test(error.message)) marsh.skipped.push(`${policyType}:job_open`);
        else marsh.skipped.push(`${policyType}:${error.message}`);
      } else {
        marsh.enqueued.push(policyType);
      }
    }
  }

  let idfy: { enqueued: boolean; skipped?: string } = { enqueued: false };
  if (
    !idfyRequiredForRole({
      designationCode: input.designationCode,
      designationName: input.designation,
      isDeliveryAssociate: input.isDeliveryAssociate
    })
  ) {
    idfy = { enqueued: false, skipped: "da_amazon_bgc" };
  } else {
    const email = normalizeEmail(input.email);
    const fullName = String(input.fullName || "").trim();
    if (email) {
      const { data } = await supabaseAdmin
        .from("workforce_idfy_observations")
        .select("id")
        .ilike("candidate_email", email)
        .limit(1);
      if (data?.length) {
        return { marsh, idfy: { enqueued: false, skipped: "observation_email" } };
      }
    }
    if (fullName) {
      const { data } = await supabaseAdmin
        .from("workforce_idfy_observations")
        .select("id,candidate_name")
        .ilike("candidate_name", `%${fullName.replace(/[%_]/g, "")}%`)
        .limit(50);
      const target = normalizeName(fullName);
      if ((data ?? []).some((row) => normalizeName(row.candidate_name) === target)) {
        return { marsh, idfy: { enqueued: false, skipped: "observation_name" } };
      }
    }

    const { data: settings } = await supabaseAdmin
      .from("idfy_enroll_settings")
      .select("buffer_days,enabled")
      .eq("company_id", input.companyId)
      .maybeSingle();
    if (settings && settings.enabled === false) {
      idfy = { enqueued: false, skipped: "disabled" };
    } else {
      const bufferDays = Math.max(0, Number(settings?.buffer_days) || 0);
      const licenseNo = String(input.drivingLicenseNo || "").trim();
      const hasDl = Boolean(input.hasDrivingLicence && licenseNo) || Boolean(licenseNo);
      const templateKey = hasDl ? "out_on_road" : "non_out_on_road";
      const templateName = hasDl ? "Out on Road Associates" : "Non Out on Road Associates";
      const scheduledFor = new Date(Date.now() + bufferDays * 86_400_000).toISOString();
      const { error } = await supabaseAdmin.from("idfy_enroll_jobs").insert({
        company_id: input.companyId,
        account_key: input.accountKey ?? "edsp",
        profile_type: input.profileType,
        profile_id: input.profileId,
        pan: pan || null,
        email: email || null,
        full_name: fullName || null,
        payload: {
          ...input.payload,
          idfyTemplateKey: templateKey,
          idfyTemplateName: templateName,
          hasDrivingLicence: hasDl,
          drivingLicenseNo: input.drivingLicenseNo ?? null,
          dlFrontPath: input.dlFrontPath ?? null,
          dlBackPath: input.dlBackPath ?? null
        },
        status: "queued",
        scheduled_for: scheduledFor
      });
      if (error) {
        if (/duplicate|unique/i.test(error.message)) idfy = { enqueued: false, skipped: "job_open" };
        else idfy = { enqueued: false, skipped: error.message };
      } else {
        idfy = { enqueued: true };
      }
    }
  }

  return { marsh, idfy };
}

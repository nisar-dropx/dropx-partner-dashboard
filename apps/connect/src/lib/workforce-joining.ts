/** Pure joining rules. Provider effective dates, never entry timestamps, end training. */
export const joiningStages = {
  applicant: "Applicants", awaiting_arrival: "Awaiting arrival", training: "Training",
  awaiting_activation: "Awaiting activation", ready: "Ready to start", active: "Active", offboarded: "Offboarded", closed: "Closed applications"
} as const;
export type JoiningStage = keyof typeof joiningStages;
export type TrainingPolicy={id:string;station_id:string;name:string;daily_rate:number|string;minimum_minutes:number;policy_reference:string;effective_from:string;effective_to:string|null;is_active:boolean};
export const amazonTasks = {
  associate_settings: {label:"Station, service & supervisor settings",owner:"Workforce"},
  invitation: {label:"Accept invitation",owner:"Associate"},
  personal_information: {label:"Personal information",owner:"Associate"},
  drivers_license: {label:"Driver’s licence details",owner:"Associate"},
  agreement: {label:"Agreement & privacy notice",owner:"Associate"},
  photo: {label:"Badge photo",owner:"Associate"},
  bgc_data: {label:"Background-check information & consent",owner:"Associate"},
  bgc_reacceptance: {label:"BGC agreement re-acceptance (if requested)",owner:"Associate"},
  training_course: {label:"Videos / training course",owner:"Associate"},
  driving_record: {label:"Driver record verification",owner:"Amazon"},
  background_check: {label:"Background check / vendor processing",owner:"Amazon"},
  account_setup: {label:"Account setup / provisioning",owner:"Amazon"},
  badge_printing: {label:"Badge printing",owner:"Amazon"},
  virtual_id: {label:"Virtual ID verification",owner:"Amazon"},
  licence_verification: {label:"Licence verification",owner:"Amazon"},
  pan_verification: {label:"PAN verification",owner:"Amazon"}
} as const;
export const amazonTaskStates = {pending:"Pending",in_progress:"In progress",complete:"Complete",blocked:"Blocked",not_required:"Not required"} as const;
/** Invitation-only defaults. Never rewrite the canonical legal full name. */
export function invitationName(fullName:string) {
  const parts=fullName.trim().split(/\s+/).filter(Boolean);
  return {first_name:parts.length>1 ? parts.slice(0,-1).join(" ") : parts[0] || "",last_name:parts.at(-1) || "",suffix:"",single_name:parts.length===1};
}
export const providerStages = {
  not_started: "Not started", email_setup: "Associate email required", documents_pending: "Documents pending",
  invitation_sent: "Invitation sent", invitation_accepted: "Invitation accepted", app_details: "App details pending",
  submitted: "Submitted to provider", verification_pending: "Verification pending", background_check: "Background check",
  course_pending: "Associate training course pending", provisioning: "ID provisioning",
  activated: "Activated — mapping required", blocked: "Blocked", withdrawn: "Withdrawn"
} as const;
export type JoiningPlan = {
  workforce_id: string; station_id: string; mode: "training" | "direct"; eligible_from: string;
  daily_rate: number | string | null; minimum_minutes: number; terms_reference: string;
  terms_accepted_on: string; training_completed_on: string | null; closed_on: string | null;
  provider_stage: keyof typeof providerStages; provider_reference: string | null; provider_submitted_on: string | null;
  provider_activated_on: string | null; next_follow_up_on: string | null; owner_note: string | null;
  contact_email?: string | null; assigned_to?: string | null;
  amazon_tasks?: Partial<Record<keyof typeof amazonTasks,keyof typeof amazonTaskStates>>;
  provider_profile_id?: string | null;
  invitation_first_name?: string | null; invitation_last_name?: string | null; invitation_suffix?: string | null;
  training_policy_id?: string | null;
  version: number; updated_at: string; updated_by: string;
};
export type JoiningPerson = {
  id: string; location_id: string; source_profile_type?: string | null; source_profile_id?: string | null;
  onboarding_status: string | null; lifecycle_status: string | null; is_active: boolean;
  onboarding_approved_at?: string | null; last_working_date?: string | null;
};
export type JoiningMapping = {
  id: string; workforce_id?: string | null; field_executive_id?: string | null; contractor_id?: string | null;
  employee_id?: string | null; effective_from: string; effective_to: string | null; status: string;
  provider_member_id: string; provider_id?: string; station_id?: string | null;
};
export type JoiningAttendance = {
  id: string; workforce_id: string | null; field_executive_id: string | null; contractor_id: string | null;
  punch_date: string; in_time: string | null; out_time: string | null; work_minutes: number | null;
  status: string | null; punch_in_location_id: string | null; location_id: string | null;
  in_source: string | null; out_source: string | null; enrolment_id: string; updated_at: string;
  flagged?: boolean;
};
export function belongsToPerson(row: {workforce_id?: string | null; field_executive_id?: string | null; contractor_id?: string | null; employee_id?: string | null}, person: JoiningPerson) {
  if (row.workforce_id) return row.workforce_id === person.id;
  const type = person.source_profile_type;
  return Boolean(person.source_profile_id && (type === "field_executive" ? row.field_executive_id === person.source_profile_id
    : type === "contractor" ? row.contractor_id === person.source_profile_id : false));
}
export function firstProviderMapping(person: JoiningPerson, mappings: JoiningMapping[]) {
  // Include closed mappings: losing/replacing an ID must never restart training.
  return mappings.filter(row => row.status !== "cancelled" && belongsToPerson(row, person))
    .sort((a,b) => a.effective_from.localeCompare(b.effective_from) || a.id.localeCompare(b.id))[0] ?? null;
}
export function isJoiningApproved(person: JoiningPerson) {
  return ["approved", "active"].includes(person.onboarding_status || "");
}
export function isBiometricDay(row: JoiningAttendance, stationId: string) {
  return Boolean(row.in_time && !row.flagged && row.punch_in_location_id === stationId
    && (!row.in_source || row.in_source === "biometric"));
}
export function joiningState(person: JoiningPerson, plan: JoiningPlan | null, mappings: JoiningMapping[], attendance: JoiningAttendance[], today: string) {
  const mapping = firstProviderMapping(person, mappings);
  const days = plan ? attendance.filter(row => belongsToPerson(row, person) && row.punch_date >= plan.eligible_from
    && row.punch_date <= today && isBiometricDay(row, plan.station_id)).sort((a,b) => a.punch_date.localeCompare(b.punch_date)) : [];
  const firstPunch = days[0]?.punch_date ?? null;
  const firstRegularDay = mapping ? days.find(row => row.punch_date >= mapping.effective_from)?.punch_date ?? null : null;
  let stage: JoiningStage;
  if (["inactive", "offboarded", "exited", "terminated", "resigned", "settled"].includes(person.lifecycle_status || "") || person.last_working_date && person.last_working_date < today) stage = "offboarded";
  else if (["rejected", "cancelled"].includes(person.onboarding_status || "") || plan?.closed_on) stage = "closed";
  else if (!isJoiningApproved(person)) stage = "applicant";
  // Existing approved active profiles retain their operational state; missing
  // provider mapping is a separate readiness issue, not a new arrival.
  else if (person.is_active) stage = "active";
  else if (mapping && mapping.effective_from <= today) {
    const currentMapping = mappings.some(row => belongsToPerson(row, person) && row.status !== "cancelled" && row.effective_from <= today && (!row.effective_to || row.effective_to >= today));
    stage = currentMapping ? (firstRegularDay || person.is_active ? "active" : "ready") : "awaiting_activation";
  }
  else if (plan?.mode === "direct" || plan?.training_completed_on && plan.training_completed_on <= today) stage = "awaiting_activation";
  else if (firstPunch && plan?.mode === "training") stage = "training";
  else stage = "awaiting_arrival";
  return { stage, firstPunch, firstRegularDay, mapping };
}

export type TrainingEntitlement = { attendance: JoiningAttendance; amount: number; holds: string[]; cutoff: string | null };
export function trainingEntitlements(person: JoiningPerson, plan: JoiningPlan, mappings: JoiningMapping[], attendance: JoiningAttendance[], from: string, to: string): TrainingEntitlement[] {
  if (plan.mode !== "training" || !isJoiningApproved(person) && !person.onboarding_approved_at) return [];
  const cutoff = firstProviderMapping(person, mappings)?.effective_from ?? null;
  const byDay = new Map<string, JoiningAttendance[]>();
  for (const row of attendance) {
    if (!belongsToPerson(row, person) || row.punch_date < from || row.punch_date > to || row.punch_date < plan.eligible_from
      || row.punch_date < plan.terms_accepted_on || !row.in_time || cutoff && row.punch_date >= cutoff
      || plan.closed_on && row.punch_date > plan.closed_on || person.last_working_date && row.punch_date > person.last_working_date) continue;
    byDay.set(row.punch_date, [...byDay.get(row.punch_date) ?? [], row]);
  }
  return [...byDay.values()].map(rows => {
    // A duplicate person/day never doubles pay; conflicting sources require review.
    rows.sort((a,b) => a.id.localeCompare(b.id));
    const row = rows[0]; const holds: string[] = [];
    if (["inactive", "offboarded", "exited", "terminated", "resigned", "settled"].includes(person.lifecycle_status || "") && !person.last_working_date && !plan.closed_on) holds.push("Confirm the last working date before settling an exited associate's training earnings");
    if (row.flagged) holds.push("Biometric attendance has a flagged punch; resolve before payment");
    if (rows.length > 1) holds.push("Multiple attendance records for this person/day; reconcile before payment");
    if (!isBiometricDay(row, plan.station_id)) holds.push("Verify biometric attendance at the agreed training station");
    if (row.status !== "P" || !row.out_time || row.out_time <= row.in_time! || Number(row.work_minutes || 0) < plan.minimum_minutes) holds.push("Incomplete training attendance; review punches and eligible duration");
    if (row.out_source && row.out_source !== "biometric") holds.push("Training attendance contains a non-biometric checkout; review required");
    if (plan.training_completed_on && row.punch_date > plan.training_completed_on) holds.push("Training completed; approve a separate waiting/work arrangement");
    const rate = plan.daily_rate === null ? NaN : Number(plan.daily_rate);
    if (!Number.isFinite(rate) || rate <= 0) holds.push("An agreed positive training rate is required");
    return { attendance: row, amount: Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) / 100 : 0, holds, cutoff };
  });
}

/** Two distinct, complete training days unlock the invitation task, not a paid external action. */
export function providerInvitationEligibility(person: JoiningPerson, plan: JoiningPlan | null, mappings: JoiningMapping[], attendance: JoiningAttendance[], today: string) {
  if (!isJoiningApproved(person) || !plan || plan.closed_on || ["offboarded", "exited", "settled", "inactive"].includes(person.lifecycle_status || "")) return { eligible: false, days: 0 };
  if (firstProviderMapping(person,mappings)) return {eligible:false,days:0};
  if (plan.mode === "direct") return { eligible: true, days: 0 };
  const eligibleDays = trainingEntitlements(person, plan, mappings, attendance, plan.eligible_from, today).filter(row => !row.holds.length);
  return { eligible: eligibleDays.length >= 2, days: eligibleDays.length };
}

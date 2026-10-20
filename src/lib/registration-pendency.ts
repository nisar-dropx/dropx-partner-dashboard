import { intersectProfileFieldChannelRules, normalizeCategoryProfileFieldRules, profileFieldRulesForCategory, workforceProfileFields } from "./profile-field-rules.ts";
import { registrationFilledFields, registrationProgress } from "./workforce-registration-progress.ts";

export const registrationEvents = ["registration_pendency_morning", "registration_pendency_afternoon"] as const;
export type RegistrationEvent = typeof registrationEvents[number];
export type RegistrationRow = {
  key: string; workspace: "People" | "Workforce"; profileType: string; id: string;
  reference: string; name: string; designation: string; stationId: string; stationCode: string; stationName: string;
  status: string; stage: "pending" | "returned" | "review"; missing: string[]; optionalMissing: string[];
  requiredFilled: number; requiredTotal: number; groups: string; action: string;
  joinedAt: string; updatedAt: string; draftAt: string; ageDays: number | null;
  managerName: string; managerEmail: string; href: string;
};
export type RegistrationRecipient = { email: string; name: string; profileKeys: string[] };
export type RegistrationSnapshot = { date: string; checkedAt: string; rows: RegistrationRow[]; recipients: RegistrationRecipient[]; unrouted: RegistrationRow[] };
export type RegistrationInput = {
  profile: Record<string, unknown>; profileType: "employee" | "contractor" | "workforce";
  designation: {name: string; profile_field_rules?: unknown}; categoryRules: unknown;
  station: {id: string; station_code: string; station_name: string | null};
  draft?: {draft_data?: unknown; file_paths?: unknown; updated_at?: string} | null;
  date: string;
};

export function registrationRow(input: RegistrationInput): RegistrationRow | null {
  const {profile:p,profileType,station,designation,date}=input;
  const raw=String(profileType==="employee"?p.profile_completion_status:p.onboarding_status).toLowerCase();
  const lifecycle=String(p.people_lifecycle_status||p.lifecycle_status||"").toLowerCase();
  if(p.deleted_at || ["suspended","offboarding","offboarded","inactive","exited","cancelled"].includes(lifecycle)
    || ["reclassified","moved_to_vendor"].includes(String(p.migration_state||""))
    || !["pending","returned","rejected","under_review","submitted","approved"].includes(raw))return null;
  // Pending Workforce registration is independent of its operational is_active flag.
  if(profileType!=="workforce" && p.is_active===false)return null;
  const category=profileType==="employee"?"employees":profileType==="contractor"?"contractors":"workforce";
  const categoryRules=normalizeCategoryProfileFieldRules(input.categoryRules);
  const merged=designation.profile_field_rules==null?categoryRules:intersectProfileFieldChannelRules(categoryRules,profileFieldRulesForCategory(designation.profile_field_rules,category));
  const statutory=Array.isArray(p.statutory_applicability)?p.statutory_applicability.map(String):[];
  const applicable=(key:string)=>!(["pf_uan","pf_account_no"].includes(key)&&!statutory.includes("pf"))&&!(key==="esi_no"&&!statutory.includes("esi"));
  const rules={enabled:merged.dropx_one.enabled.filter(applicable),required:merged.dropx_one.required.filter(applicable)};
  // Normalize employee aliases before using the shared DropX One draft checker.
  const values=profileType==="employee"?{...p,postal_pin:p.pincode,ifsc_code:p.ifsc}:p;
  const stage=["under_review","submitted","approved"].includes(raw)?"review":["returned","rejected"].includes(raw)?"returned":"pending";
  // Old drafts must never override an already-submitted profile.
  const draft=stage==="review"?null:input.draft;
  const flags=registrationFilledFields(values,draft),progress=registrationProgress(flags,rules,workforceProfileFields);
  const missing=progress.groups.flatMap(group=>group.missing);
  const optionalMissing=workforceProfileFields.filter(field=>rules.enabled.includes(field.key)&&!rules.required.includes(field.key)&&!flags[field.key]).map(field=>field.label);
  const created=String(p.created_at||p.date_of_join||"").slice(0,10);
  const ageDays=/^\d{4}-\d{2}-\d{2}$/.test(created)?Math.max(0,Math.floor((Date.parse(`${date}T00:00:00Z`)-Date.parse(`${created}T00:00:00Z`))/86400000)):null;
  const status=stage==="review"?(raw==="approved"?"Approved · activation pending":"Submitted · awaiting review"):stage==="returned"?"Returned · correction required":draft?"Draft · not submitted":"Registration pending";
  const action=!rules.enabled.length?"Configure registration fields in the designation/category master":stage==="review"?"Follow up with the authorized reviewer; do not resubmit":missing.length?"Complete missing required details in DropX One, then submit":"Review saved details and submit in DropX One";
  const id=String(p.id);
  return {key:`${profileType}:${id}`,workspace:profileType==="workforce"?"Workforce":"People",profileType,id,reference:String(p.employee_code||p.dropx_id||"Not assigned"),name:String(p.full_name||"Unnamed profile"),designation:designation.name,
    stationId:station.id,stationCode:station.station_code,stationName:station.station_name||station.station_code,
    status,stage,missing,optionalMissing,requiredFilled:rules.required.filter(key=>flags[key]).length,requiredTotal:rules.required.length,
    groups:progress.groups.filter(group=>group.missing.length).map(group=>`${group.name}: ${group.missing.join(", ")}`).join("\n"),
    action,joinedAt:String(p.date_of_join||""),updatedAt:String(p.updated_at||""),draftAt:String(draft?.updated_at||""),ageDays,
    managerName:"",managerEmail:"",href:profileType==="workforce"?`https://ops.dropxlogistics.com/work-force-register?edit=${encodeURIComponent(id)}`:`https://people.dropxlogistics.com/people/${profileType==="employee"?"":"contractors/"}${encodeURIComponent(id)}`};
}

export function registrationSnapshot(date:string,checkedAt:string,rows:RegistrationRow[]):RegistrationSnapshot {
  if(new Set(rows.map(row=>row.key)).size!==rows.length)throw Error("Duplicate registration identities; report held.");
  const recipients=new Map<string,RegistrationRecipient>();
  for(const row of rows){
    if(!row.managerEmail)continue;
    const recipient=recipients.get(row.managerEmail)||{email:row.managerEmail,name:row.managerName,profileKeys:[]};
    recipient.profileKeys.push(row.key);recipients.set(recipient.email,recipient);
  }
  return {date,checkedAt,rows:rows.sort((a,b)=>a.stationCode.localeCompare(b.stationCode)||(b.ageDays||0)-(a.ageDays||0)||a.name.localeCompare(b.name)),recipients:[...recipients.values()].sort((a,b)=>a.email.localeCompare(b.email)),unrouted:rows.filter(row=>!row.managerEmail)};
}

import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { loadCodTeamDirectory } from "@/lib/ops-pulse/cod-station-team";
import {
  attendanceWorkerKey,
  lastShiftWorkerKeys,
  normalizeWhatsAppNumber,
  presentWorkerKeys,
  teamLeaderMentionNumbers,
  type PresencePunch,
} from "./lm-dispatch-mentions-core";

export type MentionManagerPolicy = "none" | "cluster_then_aom";
export type MentionRouteConfig = {
  mentions?: string[];
  mention_manager_policy?: MentionManagerPolicy;
  mention_designation_codes?: string[];
  mention_present_designation_codes?: string[];
  mention_latest_shift_designation_codes?: string[];
};
export type MentionSource = { id: string; station_code: string };

type PunchRow = {
  id: string;
  employee_id: string | null;
  contractor_id: string | null;
  location_id: string | null;
  punch_date: string;
  punch_time: string;
  punch_label: string;
  source: string | null;
};

function timestamp(day: string, time: string) {
  if (/^\d{4}-\d{2}-\d{2}T/.test(time)) return time;
  return `${day}T${time}+05:30`;
}

export async function resolveRouteMentionNumbers(
  companyId: string,
  sources: MentionSource[],
  route: MentionRouteConfig,
  day: string,
) {
  const staticNumbers = (route.mentions ?? []).map(normalizeWhatsAppNumber).filter((value): value is string => Boolean(value));
  if (!sources.length) return [...new Set(staticNumbers)];
  const managerPolicy = route.mention_manager_policy ?? "none";
  const designationCodesAlways = new Set((route.mention_designation_codes ?? []).map(code => code.trim().toUpperCase()).filter(Boolean));
  const designationCodes = new Set((route.mention_present_designation_codes ?? []).map(code => code.trim().toUpperCase()).filter(Boolean));
  const latestShiftCodes = new Set((route.mention_latest_shift_designation_codes ?? []).map(code=>code.trim().toUpperCase()).filter(Boolean));
  if (managerPolicy === "none" && !designationCodesAlways.size && !designationCodes.size && !latestShiftCodes.size) return [...new Set(staticNumbers)];

  const locationIds = sources.map(row => row.id);
  const hierarchy = await loadPeopleOperationalHierarchy(companyId, locationIds, { includeStationResponsibilities: true, asOf: day });
  if (hierarchy.error) throw new Error(`People manager mapping unavailable: ${hierarchy.error}`);
  const managerPersonIds = new Set<string>();
  if (managerPolicy === "cluster_then_aom") {
    for (const source of sources) {
      const station = hierarchy.byLocation.get(source.id);
      const managers = station?.clusterManagers?.length ? station.clusterManagers : station?.areaOperationsManagers ?? [];
      managers.forEach(person => managerPersonIds.add(person.personId));
    }
  }

  const directory = await loadCodTeamDirectory(companyId, locationIds, [...managerPersonIds], day, [...new Set([...designationCodesAlways,...designationCodes,...latestShiftCodes])]);
  const byPerson = new Map(directory.map(person => [person.personId, person]));
  const dynamicNumbers = new Set<string>();
  for (const personId of managerPersonIds) {
    const phone = normalizeWhatsAppNumber(byPerson.get(personId)?.phone);
    if (phone) dynamicNumbers.add(phone);
  }
  for (const person of directory) {
    if (!designationCodesAlways.has(String(person.roleCode ?? "").trim().toUpperCase())) continue;
    const phone = normalizeWhatsAppNumber(person.phone);
    if (phone) dynamicNumbers.add(phone);
  }

  const attendanceCandidates = directory.filter(person =>
    !person.manager && Boolean(person.locationId) && (designationCodes.has(String(person.roleCode ?? "").trim().toUpperCase()) || latestShiftCodes.has(String(person.roleCode ?? "").trim().toUpperCase()))
  );
  if (attendanceCandidates.length) {
    if (!supabaseAdmin) throw new Error("Biometric attendance is unavailable.");
    const employeeIds = attendanceCandidates.filter(row => row.workerType === "employee").map(row => row.workerId);
    const contractorIds = attendanceCandidates.filter(row => row.workerType === "contractor").map(row => row.workerId);
    const queries = [
      employeeIds.length ? readAllRows(supabaseAdmin.from("attendance_punches")
        .select("id,employee_id,contractor_id,location_id,punch_date,punch_time,punch_label,source")
        .eq("company_id", companyId).eq("punch_date", day).in("employee_id", employeeIds).order("punch_time").order("id")) : Promise.resolve({ data: [], error: null }),
      contractorIds.length ? readAllRows(supabaseAdmin.from("attendance_punches")
        .select("id,employee_id,contractor_id,location_id,punch_date,punch_time,punch_label,source")
        .eq("company_id", companyId).eq("punch_date", day).in("contractor_id", contractorIds).order("punch_time").order("id")) : Promise.resolve({ data: [], error: null }),
    ];
    const results = await Promise.all(queries);
    const failed = results.find(result => result.error);
    if (failed?.error) throw new Error(`Biometric attendance unavailable: ${failed.error.message}`);
    const punches: PresencePunch[] = [];
    for (const row of results.flatMap(result => (result.data ?? []) as PunchRow[])) {
      if (row.employee_id) punches.push({ workerType: "employee", workerId: row.employee_id, locationId: row.location_id, punchLabel: row.punch_label, punchTime: timestamp(row.punch_date, row.punch_time), source: row.source, id: row.id });
      else if (row.contractor_id) punches.push({ workerType: "contractor", workerId: row.contractor_id, locationId: row.location_id, punchLabel: row.punch_label, punchTime: timestamp(row.punch_date, row.punch_time), source: row.source, id: row.id });
    }
    const expected = new Map(attendanceCandidates.map(person => [attendanceWorkerKey(person.workerType as "employee"|"contractor", person.workerId), person.locationId!]));
    const present = presentWorkerKeys(punches, expected);
    const latestShift = lastShiftWorkerKeys(punches,expected);
    for (const person of attendanceCandidates) {
      const code=String(person.roleCode??"").trim().toUpperCase();
      const worker=attendanceWorkerKey(person.workerType as "employee"|"contractor",person.workerId);
      if (!(designationCodes.has(code)&&present.has(worker)) && !(latestShiftCodes.has(code)&&latestShift.has(worker))) continue;
      const phone = normalizeWhatsAppNumber(person.phone);
      if (phone) dynamicNumbers.add(phone);
    }
  }
  return [...new Set([...staticNumbers, ...dynamicNumbers])];
}

export async function resolveTeamLeaderMentionNumbers(companyId: string, sources: MentionSource[], day: string) {
  const locationIds = [...new Set(sources.map(source => source.id))];
  if (!locationIds.length) return [];
  const directory = await loadCodTeamDirectory(companyId, locationIds, [], day);
  return teamLeaderMentionNumbers(directory, locationIds);
}

/** Bank reminders address station TLs first; managers and explicitly configured
 * central CT contacts are FYI only. Never expand roles to all company staff. */
export async function resolveBankReminderMentions(companyId:string,sources:MentionSource[],route:MentionRouteConfig,day:string) {
  const locations=sources.map(source=>source.id);
  const hierarchy=await loadPeopleOperationalHierarchy(companyId,locations,{includeStationResponsibilities:true,asOf:day});
  if(hierarchy.error) throw new Error(hierarchy.error);
  const clusterIds=new Set<string>(),aomIds=new Set<string>();
  if(route.mention_manager_policy==="cluster_then_aom") for(const source of sources) {
    const station=hierarchy.byLocation.get(source.id);
    if(station?.clusterManagers.length) station.clusterManagers.forEach(person=>clusterIds.add(person.personId));
    else station?.areaOperationsManagers.forEach(person=>aomIds.add(person.personId));
  }
  const directory=await loadCodTeamDirectory(companyId,locations,[...clusterIds,...aomIds],day);
  // Resolve only active corporate Workspace accounts linked to the selected
  // People manager. Employee/contractor contact fields may be personal email.
  if(!supabaseAdmin) throw new Error("Workspace contacts are unavailable.");
  const managerIds=[...new Set([...clusterIds,...aomIds])];
  const managerContacts=managerIds.length?await readAllRows(supabaseAdmin.from("google_workspace_accounts")
    .select("id,person_id,primary_email").eq("company_id",companyId)
    .eq("account_type","person").eq("account_state","active")
    .eq("suspended",false).eq("archived",false).eq("available_for_reassignment",false)
    .in("person_id",managerIds).order("id")):{data:[],error:null};
  if(managerContacts.error) throw new Error(managerContacts.error.message);
  const managerEmails=[...new Set((managerContacts.data||[]).map(row=>String(row.primary_email||"").trim().toLowerCase()).filter(email=>/^[^\s@]+@dropxlogistics\.com$/.test(email)))];
  const numbers=(people:typeof directory)=>[...new Set(people.map(person=>normalizeWhatsAppNumber(person.phone)).filter((number):number is string=>Boolean(number)))];
  const roles=new Set(route.mention_designation_codes||[]);
  return {
    tl:roles.has("TL")?teamLeaderMentionNumbers(directory,locations):[],
    ct:[...new Set([...(route.mentions||[]).map(normalizeWhatsAppNumber).filter((number):number is string=>Boolean(number)),...numbers(directory.filter(person=>roles.has(person.roleCode)&&["CT","CONTROL_TOWER_ASSOCIATE"].includes(person.roleCode)))])],
    cluster:numbers(directory.filter(person=>clusterIds.has(person.personId))),
    aom:numbers(directory.filter(person=>aomIds.has(person.personId))),
    managerEmails,
  };
}

/** Only the explicitly configured central escalation roles may cross station scope. */
export async function resolveHighValueEscalationNumbers(company:string,sources:MentionSource[],day:string,roles:string[]){
 if(!supabaseAdmin||!sources.length)return [];
 const codes=roles.filter(code=>['HLM','SLPM'].includes(code));
 if(!codes.length)return [];
 const designations=await supabaseAdmin.from('designations').select('id').eq('company_id',company).eq('is_active',true).in('code',codes);
 if(designations.error)throw new Error(designations.error.message);
 if(!designations.data.length)return [];
 const assignments=await readAllRows(supabaseAdmin.from('hr_work_assignments').select('id,hr_engagements!inner(person_id,status)').eq('company_id',company).eq('is_primary',true).lte('effective_from',day).or(`effective_to.is.null,effective_to.gte.${day}`).in('designation_id',designations.data.map(d=>d.id)).eq('hr_engagements.status','active').order('id'));
 if(assignments.error)throw new Error(assignments.error.message);
 const ids=(assignments.data||[]).flatMap(a=>{const e=Array.isArray(a.hr_engagements)?a.hr_engagements[0]:a.hr_engagements;return e?.person_id?[e.person_id]:[];});
 const people=await loadCodTeamDirectory(company,sources.map(s=>s.id),ids,day);
 return [...new Set(people.filter(p=>codes.includes(p.roleCode)).map(p=>normalizeWhatsAppNumber(p.phone)).filter((n):n is string=>!!n))];
}

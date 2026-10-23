import type { SupabaseClient } from "@supabase/supabase-js";
import {loadPeopleOperationalHierarchy} from "./people-operational-hierarchy";
import {registrationRow,registrationSnapshot,uniqueRegistrationManagerEmail,type RegistrationRow} from "./registration-pendency.ts";

type Data=Record<string,unknown>;
async function all<T=Data>(db:SupabaseClient,company:string,table:string,columns:string,filters:Record<string,unknown>={}):Promise<T[]>{
  const rows:T[]=[];
  for(let offset=0;offset<50000;offset+=1000){
    let q=db.from(table).select(columns).eq("company_id",company);
    for(const [key,value] of Object.entries(filters))q=value===null?q.is(key,null):q.eq(key,value);
    const result=await q.order("id").range(offset,offset+999);
    if(result.error)throw Error(`${table} source unavailable: ${result.error.message}`);
    rows.push(...(result.data||[]) as T[]);if((result.data?.length||0)<1000)return rows;
  }
  throw Error(`${table} source exceeds report limit; no partial report sent.`);
}
const fields="id,full_name,date_of_join,location_id,is_active,created_at,updated_at,deleted_at,statutory_applicability,gender,date_of_birth,aadhaar_number,pan_number,eshram_uan,father_name,blood_group,is_handicapped,address,state_code,landmark,bank_account_no,pf_uan,pf_account_no,esi_no,driving_license_no,driving_license_exp_date,vehicle_reg_no,vehicle_reg_exp_date,vehicle_insurance_exp_date,vehicle_pollution_exp_date,emergency_contact_number,emergency_contact_name,emergency_contact_relation,aadhaar_front_path,aadhaar_back_path,pan_upload_path,dl_front_path,dl_back_path,profile_photo_path";
type Station={id:string;station_code:string;station_name:string|null;hide_from_location_list:boolean|null};
type Designation={id:string;name:string;code:string;profile_field_rules:unknown;profile_destination:string|null};
type Person={id:string;display_name:string;status:string};
type Engagement={id:string;person_id:string;employee_id:string|null;contractor_id:string|null;workforce_id:string|null;status:string;start_date:string|null;end_date:string|null};
type Assignment={id:string;engagement_id:string;location_id:string|null;designation_id:string|null;effective_from:string;effective_to:string|null;is_primary:boolean};
type Relationship={id:string;subject_assignment_id:string;manager_assignment_id:string;effective_from:string;effective_to:string|null;is_primary:boolean};
type Profile={id:string;full_name:string;email:string|null};
type Membership={id:string;user_id:string;role_id:string;location_scope_ids:string[]|null;has_all_location_access:boolean};
const current=(row:{effective_from:string;effective_to:string|null},date:string)=>row.effective_from.slice(0,10)<=date&&(!row.effective_to||row.effective_to.slice(0,10)>=date);

/** Same canonical profile statuses, draft evidence and field rules as DropX One.
 * Sensitive field values are used only to calculate presence; never returned or mailed. */
export async function loadRegistrationPendency(db:SupabaseClient,company:string,date:string,domain:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!domain)throw Error("Registration schedule configuration is incomplete.");
  const [employees,contractors,workforce,stations,designations,categories,drafts,people,engagements,assignments,relationships,links,profiles,memberships,roles]=await Promise.all([
    all(db,company,"employees",`${fields},employee_code,designation_id,profile_completion_status,people_lifecycle_status,pincode,ifsc`,{deleted_at:null}),
    all(db,company,"contractors",`${fields},dropx_id,designation,onboarding_status,people_lifecycle_status,postal_pin,ifsc_code`,{deleted_at:null}),
    all(db,company,"workforce",`${fields},dropx_id,designation,designation_id,onboarding_status,lifecycle_status,postal_pin,ifsc_code,migration_state,source_profile_type,source_profile_id`,{deleted_at:null}),
    all<Station>(db,company,"stations","id,station_code,station_name,hide_from_location_list",{is_active:true}),
    all<Designation>(db,company,"designations","id,name,code,profile_field_rules,profile_destination",{is_active:true}),
    all<{id:string;code:string;profile_field_rules:unknown}>(db,company,"workforce_categories","id,code,profile_field_rules",{is_active:true}),
    all<{id:string;profile_type:string;account_id:string;draft_data:unknown;file_paths:unknown;updated_at:string}>(db,company,"mob_app_registration_drafts","id,profile_type,account_id,draft_data,file_paths,updated_at"),
    all<Person>(db,company,"hr_people","id,display_name,status",{status:"active"}),
    all<Engagement>(db,company,"hr_engagements","id,person_id,employee_id,contractor_id,workforce_id,status,start_date,end_date",{status:"active"}),
    all<Assignment>(db,company,"hr_work_assignments","id,engagement_id,location_id,designation_id,effective_from,effective_to,is_primary",{is_primary:true}),
    all<Relationship>(db,company,"hr_reporting_relationships","id,subject_assignment_id,manager_assignment_id,effective_from,effective_to,is_primary",{is_primary:true,relationship_type:"solid_line"}),
    all<{id:string;person_id:string;user_id:string}>(db,company,"hr_user_person_links","id,person_id,user_id",{status:"active"}),
    all<Profile>(db,company,"profiles","id,full_name,email",{is_active:true}),
    all<Membership>(db,company,"company_product_memberships","id,user_id,role_id,location_scope_ids,has_all_location_access",{product_code:"operations",is_active:true}),
    all<{id:string;code:string}>(db,company,"user_roles","id,code",{is_active:true})
  ]);
  const activePeople=new Map(people.map(p=>[p.id,p]));
  const activeEngagements=engagements.filter(e=>activePeople.has(e.person_id)&&(!e.start_date||e.start_date<=date)&&(!e.end_date||e.end_date>=date));
  const engagementById=new Map(activeEngagements.map(e=>[e.id,e]));
  const activeAssignments=assignments.filter(a=>engagementById.has(a.engagement_id)&&current(a,date));
  const assignmentById=new Map(activeAssignments.map(a=>[a.id,a]));
  const stationById=new Map(stations.filter(s=>!s.hide_from_location_list&&!/^TEST(?:$|[\s_-])/i.test(s.station_code)).map(s=>[s.id,s]));
  const designationById=new Map(designations.map(d=>[d.id,d]));
  const designationByName=new Map(designations.map(d=>[d.name.trim().toLowerCase(),d]));
  const draftsByKey=new Map(drafts.map(d=>[`${d.profile_type}:${d.account_id}`,d]));
  const hierarchy=await loadPeopleOperationalHierarchy(company,[...stationById.keys()],{includeStationResponsibilities:true,asOf:date});
  if(hierarchy.error)throw Error(hierarchy.error);
  const emailForPerson=(personId:string)=>{
    const candidates=links.filter(l=>l.person_id===personId).flatMap(l=>profiles.filter(p=>p.id===l.user_id));
    // A verified reporting manager may use a personal-domain HRMS login.
    // Identity/company membership and reporting scope, not domain, authorize this report.
    const email=uniqueRegistrationManagerEmail(candidates.map(p=>p.email));
    return email?{email,name:activePeople.get(personId)?.display_name||candidates[0].full_name}:null;
  };
  const roleById=new Map(roles.map(r=>[r.id,r.code]));
  const managerForStation=(stationId:string)=>{
    const graph=hierarchy.byLocation.get(stationId);
    if(graph?.hasClusterManagerConflict)return null;
    const chain=graph?.clusterManagers.length?graph.clusterManagers:graph?.areaOperationsManagers||[];
    const peopleIds=[...new Set(chain.map(p=>p.personId))];
    if(peopleIds.length===1)return {personId:peopleIds[0],...emailForPerson(peopleIds[0])};
    // Explicit station scope only, not blanket account access. Never guess from names.
    for(const codes of [["OPERATIONS_CLM","OPERATIONS_CM"],["OPERATIONS_AOM"]]){
      const users=memberships.filter(m=>codes.includes(roleById.get(m.role_id)||"")&&m.location_scope_ids?.includes(stationId)).map(m=>m.user_id);
      const ids=[...new Set(links.filter(l=>users.includes(l.user_id)&&activePeople.has(l.person_id)).map(l=>l.person_id))];
      if(ids.length>1)return null;
      if(ids.length===1)return {personId:ids[0],...emailForPerson(ids[0])};
    }
    return null;
  };
  const rows:RegistrationRow[]=[];
  for(const [type,list] of [["employee",employees],["contractor",contractors],["workforce",workforce]] as const){
    for(const profile of list){
      const status=String(type==="employee"?profile.profile_completion_status:profile.onboarding_status).toLowerCase();
      if(!["pending","returned","rejected","under_review","submitted","approved"].includes(status))continue;
      const personEngagements=activeEngagements.filter(e=>String(type==="employee"?e.employee_id:type==="contractor"?e.contractor_id:e.workforce_id)===String(profile.id));
      const ownAssignments=activeAssignments.filter(a=>personEngagements.some(e=>e.id===a.engagement_id)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
      const own=ownAssignments[0];
      const station=stationById.get(String(own?.location_id||profile.location_id));
      if(!station)continue;
      const designation=designationById.get(String(own?.designation_id||profile.designation_id))||designationByName.get(String(profile.designation||"").trim().toLowerCase());
      if(!designation)throw Error("A registration profile has no current designation; report held.");
      // Canonical Workforce copies of People profiles must not appear twice.
      if(type==="workforce"&&designation.profile_destination==="employees")continue;
      if(type!=="workforce"&&designation.profile_destination==="workforce"&&workforce.some(w=>w.source_profile_id===profile.id))continue;
      const category=categories.find(c=>c.code===(type==="employee"?"employees":type==="contractor"?"contractors":"workforce"));
      if(!category)throw Error("Registration category rules are missing; report held.");
      const draft=draftsByKey.get(`${type}:${profile.id}`)||(type==="workforce"?draftsByKey.get(`field_executive:${profile.id}`):null);
      const row=registrationRow({profile,profileType:type,designation,categoryRules:category.profile_field_rules,station,draft,date});
      if(!row)continue;
      const ownPerson=own?engagementById.get(own.engagement_id)?.person_id:null;
      const direct=own?relationships.filter(r=>r.subject_assignment_id===own.id&&current(r,date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]:null;
      const managerAssignment=direct?assignmentById.get(direct.manager_assignment_id):null;
      const managerPerson=managerAssignment?engagementById.get(managerAssignment.engagement_id)?.person_id:null;
      const manager=managerPerson?{personId:managerPerson,...emailForPerson(managerPerson)}:managerForStation(station.id);
      if(manager?.email&&manager.personId!==ownPerson){row.managerName=manager.name||"";row.managerEmail=manager.email;}
      rows.push(row);
    }
  }
  return registrationSnapshot(date,new Date().toISOString(),rows);
}

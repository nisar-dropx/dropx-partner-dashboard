import type {SupabaseClient} from "@supabase/supabase-js";

export function isDropxRegistrationEmail(value:string) {
 return /^[a-z0-9._%+-]+@dropxlogistics\.com$/i.test(value);
}

type Link={user_id:string;person_id:string;status:string};
type Person={id:string;status:string};
type Engagement={person_id:string;status:string;start_date:string|null;end_date:string|null;employee_id:string|null;contractor_id:string|null;workforce_id:string|null};
type Employment={id:string;is_active:boolean|null;deleted_at:string|null;people_lifecycle_status?:string|null;lifecycle_status?:string|null};
type StaffEvidence={links:Link[];people:Person[];engagements:Engagement[];employees:Employment[];contractors:Employment[];workforce:Employment[]};

/** A live login or stale active engagement cannot override an offboarded source profile. */
export function activeRegistrationStaffUserIds(evidence:StaffEvidence,date:string):Set<string> {
 const current=(e:Engagement)=>e.status==="active"&&(!e.start_date||e.start_date.slice(0,10)<=date)&&(!e.end_date||e.end_date.slice(0,10)>=date);
 const active=(p:Employment)=>p.is_active===true&&!p.deleted_at&&(p.people_lifecycle_status||p.lifecycle_status)==="active";
 const sources=[new Set(evidence.employees.filter(active).map(p=>p.id)),new Set(evidence.contractors.filter(active).map(p=>p.id)),new Set(evidence.workforce.filter(active).map(p=>p.id))];
 const activePeople=new Set(evidence.people.filter(p=>p.status==="active").map(p=>p.id));
 const employed=new Set(evidence.engagements.filter(e=>{
  const ids=[e.employee_id,e.contractor_id,e.workforce_id];
  return current(e)&&activePeople.has(e.person_id)&&ids.filter(Boolean).length===1&&ids.some((id,i)=>id&&sources[i].has(id));
 }).map(e=>e.person_id));
 const users=new Set<string>();
 for(const user of new Set(evidence.links.map(l=>l.user_id))){
  const people=new Set(evidence.links.filter(l=>l.user_id===user&&l.status==="active").map(l=>l.person_id));
  if(people.size===1&&employed.has([...people][0]))users.add(user);
 }
 return users;
}

export async function registrationRecipientRows<T>(query:(offset:number)=>PromiseLike<{data:T[]|null;error:{message:string}|null}>):Promise<T[]> {
 const rows:T[]=[];
 for(let offset=0;offset<50000;offset+=1000){
  const result=await query(offset);
  if(result.error)throw Error("Registration recipient verification unavailable.");
  rows.push(...(result.data||[]));
  if((result.data?.length||0)<1000)return rows;
 }
 throw Error("Registration recipient verification exceeds the limit.");
}

export async function loadActiveRegistrationStaff(db:SupabaseClient,company:string,date:string) {
 const rows=<T,>(table:string,columns:string)=>registrationRecipientRows<T>(offset=>db.from(table).select(columns).eq("company_id",company).order("id").range(offset,offset+999) as unknown as PromiseLike<{data:T[]|null;error:{message:string}|null}>);
 const [links,people,engagements,employees,contractors,workforce]=await Promise.all([
  rows<Link>("hr_user_person_links","user_id,person_id,status"),
  rows<Person>("hr_people","id,status"),
  rows<Engagement>("hr_engagements","person_id,status,start_date,end_date,employee_id,contractor_id,workforce_id"),
  rows<Employment>("employees","id,is_active,deleted_at,people_lifecycle_status"),
  rows<Employment>("contractors","id,is_active,deleted_at,people_lifecycle_status"),
  rows<Employment>("workforce","id,is_active,deleted_at,lifecycle_status")
 ]);
 return activeRegistrationStaffUserIds({links,people,engagements,employees,contractors,workforce},date);
}

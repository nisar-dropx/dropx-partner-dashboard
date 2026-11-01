import type {SupabaseClient} from "@supabase/supabase-js";
import type {RegistrationRecipient, RegistrationSnapshot} from "./registration-pendency.ts";
import type {RegistrationSummaryRecipient} from "./registration-summary-recipients.ts";

type Profile = {id:string; email:string|null; full_name:string|null};
type Membership = {user_id:string; role_id:string; product_code:string; has_all_location_access:boolean; location_scope_ids:string[]|null};
type Role = {id:string; code:string};
export type RegistrationMailRecipient = RegistrationRecipient & {audience:string; consolidated:boolean};

const hrRoles = new Set(["OPERATIONS_HRM", "OPERATIONS_HRE", "PEOPLE_HRM", "PEOPLE_HRE"]);
const financeRoles = new Set(["OPERATIONS_FINMGR", "OPERATIONS_ACCOUNTS", "FINANCE_FINMGR", "FINANCE_ACE", "FINANCE_ACCOUNTS"]);
const opsRoles = new Set(["OPERATIONS_CLM", "OPERATIONS_AOM", "OPERATIONS_CM", "OPERATIONS_SM", "OPERATIONS_STM", "OPERATIONS_SI", "OPERATIONS_CLUSTER_HEAD", "OPERATIONS_RM", "OPERATIONS_HLM", "OPERATIONS_NH", "OPERATIONS_BH"]);

/** All inputs must be current, active records from the same company.
 * Department rules override direct-report routing: Finance never inherits People
 * rows merely because it also has an Operations portal membership.
 */
export function resolveRegistrationTeamRecipients(snapshot:RegistrationSnapshot, profiles:Profile[], memberships:Membership[], roles:Role[]):RegistrationMailRecipient[] {
 const roleById = new Map(roles.map(r=>[r.id,r.code.trim().toUpperCase()]));
 return profiles.flatMap(profile=>{
  const email = String(profile.email||"").trim().toLowerCase();
  if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))return [];
  if(profiles.filter(p=>String(p.email||"").trim().toLowerCase()===email).length!==1)
   return [{email,name:profile.full_name||email,profileKeys:[],consolidated:false,audience:"Unverified"}];
  const grants = memberships.filter(m=>m.user_id===profile.id && ["operations","people","finance"].includes(m.product_code))
   .map(m=>({...m,code:roleById.get(m.role_id)||""}));
  const hr = grants.filter(m=>hrRoles.has(m.code));
  const finance = grants.filter(m=>financeRoles.has(m.code));
  const departments = [...hr,...finance];
  const ops = grants.filter(m=>m.product_code==="operations"&&opsRoles.has(m.code));
  if(!departments.length&&!ops.length)return [];
  const directKeys = new Set(snapshot.recipients.find(r=>r.email===email)?.profileKeys||[]);
  const includes = (grants:Membership[],station:string)=>grants.some(m=>m.has_all_location_access || m.location_scope_ids?.includes(station));
  const profileKeys = snapshot.rows.filter(row=>departments.length
   ? includes(row.workspace==="People"?hr:finance,row.stationId)
   // A blanket Ops login is not a request for a company-wide mail. Use assigned
   // locations and canonical reportees; owner summaries remain explicit opt-ins.
   : directKeys.has(row.key)||ops.some(m=>m.location_scope_ids?.includes(row.stationId))).map(row=>row.key);
  return [{email,name:profile.full_name||email,profileKeys,consolidated:false,
   audience:hr.length&&finance.length?"HR + Finance":hr.length?"HR":finance.length?"Finance":"Ops"}];
 });
}

export function registrationMailRecipients(snapshot:RegistrationSnapshot, summaries:RegistrationSummaryRecipient[]=[], teams:RegistrationMailRecipient[]=[]):RegistrationMailRecipient[] {
 const recipients = new Map<string,RegistrationMailRecipient>(snapshot.recipients.map(r=>[r.email,{...r,audience:"Ops",consolidated:false}]));
 // Keep empty team scopes as overrides, so a department cannot fall back to
 // broader manager routing after its last authorized profile is completed.
 for(const recipient of teams)recipients.set(recipient.email,recipient);
 for(const recipient of summaries)recipients.set(recipient.email,{...recipient,audience:"Owner",consolidated:true,profileKeys:snapshot.rows.map(row=>row.key)});
 return [...recipients.values()];
}

async function activeRows<T>(query:(offset:number)=>PromiseLike<{data:T[]|null;error:{message:string}|null}>):Promise<T[]> {
 const rows:T[]=[];
 for(let offset=0;offset<50000;offset+=1000){
  const result=await query(offset);
  if(result.error)throw Error("Registration team routing could not be verified.");
  rows.push(...(result.data||[]));
  if((result.data?.length||0)<1000)return rows;
 }
 throw Error("Registration team routing exceeds the verification limit.");
}

export async function loadRegistrationTeamRecipients(db:SupabaseClient,company:string,config:Record<string,unknown>,snapshot:RegistrationSnapshot) {
 if(config.team_recipients_enabled!==true)return [];
 const [profiles,memberships,roles]=await Promise.all([
  activeRows<Profile>(offset=>db.from("profiles").select("id,email,full_name").eq("company_id",company).eq("is_active",true).order("id").range(offset,offset+999)),
  activeRows<Membership>(offset=>db.from("company_product_memberships").select("user_id,role_id,product_code,has_all_location_access,location_scope_ids").eq("company_id",company).eq("is_active",true).in("product_code",["operations","people","finance"]).order("id").range(offset,offset+999)),
  activeRows<Role>(offset=>db.from("user_roles").select("id,code").eq("company_id",company).eq("is_active",true).order("id").range(offset,offset+999))
 ]);
 return resolveRegistrationTeamRecipients(snapshot,profiles,memberships,roles);
}

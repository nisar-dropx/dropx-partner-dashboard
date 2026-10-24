import type {SupabaseClient} from "@supabase/supabase-js";

type Profile={id:string;email:string|null;full_name:string|null;role_id:string|null;is_master_owner:boolean|null};
type Membership={user_id:string;role_id:string};
type Role={id:string;code:string};
export type RegistrationSummaryRecipient={email:string;name:string};

async function activeRows<T>(query:(offset:number)=>PromiseLike<{data:T[]|null;error:{message:string}|null}>):Promise<T[]>{
 const rows:T[]=[];
 for(let offset=0;offset<50000;offset+=1000){
  const result=await query(offset);
  if(result.error)throw Error("Consolidated registration recipient verification unavailable.");
  rows.push(...(result.data||[]));
  if((result.data?.length||0)<1000)return rows;
 }
 throw Error("Consolidated registration recipient verification limit reached.");
}

/** Inputs are active company records. A saved subscription never grants access. */
export function resolveRegistrationSummaryRecipients(ids:string[],profiles:Profile[],memberships:Membership[],roles:Role[]):RegistrationSummaryRecipient[]{
 const owners=new Set(roles.filter(r=>r.code.trim().toUpperCase()==="OWNER").map(r=>r.id));
 const result=new Map<string,RegistrationSummaryRecipient>();
 for(const profile of profiles){
  if(!ids.includes(profile.id))continue;
  const memberRoles=memberships.filter(m=>m.user_id===profile.id).map(m=>m.role_id);
  const effectiveRoles=memberRoles.length?memberRoles:profile.role_id?[profile.role_id]:[];
  if(!profile.is_master_owner&&!effectiveRoles.some(id=>owners.has(id)))continue;
  const email=String(profile.email||"").trim().toLowerCase();
  if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))continue;
  // Shared/ambiguous account addresses must not receive company-wide HR data.
  if(profiles.filter(p=>String(p.email||"").trim().toLowerCase()===email).length!==1)continue;
  result.set(email,{email,name:profile.full_name||email});
 }
 return [...result.values()];
}

export async function loadRegistrationSummaryRecipients(db:SupabaseClient,company:string,config:Record<string,unknown>){
 const ids=Array.isArray(config.consolidated_owner_user_ids)?config.consolidated_owner_user_ids.filter((id):id is string=>typeof id==="string"&&/^[0-9a-f-]{36}$/i.test(id)):[];
 if(!ids.length)return [];
 const [profiles,memberships,roles]=await Promise.all([
  activeRows<Profile>(offset=>db.from("profiles").select("id,email,full_name,role_id,is_master_owner").eq("company_id",company).eq("is_active",true).order("id").range(offset,offset+999)),
  activeRows<Membership>(offset=>db.from("company_product_memberships").select("user_id,role_id").eq("company_id",company).eq("product_code","operations").eq("is_active",true).in("user_id",ids).order("id").range(offset,offset+999)),
  activeRows<Role>(offset=>db.from("user_roles").select("id,code").eq("company_id",company).eq("is_active",true).order("id").range(offset,offset+999))
 ]);
 return resolveRegistrationSummaryRecipients(ids,profiles,memberships,roles);
}

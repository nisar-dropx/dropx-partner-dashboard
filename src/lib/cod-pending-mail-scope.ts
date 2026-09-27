import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import {pagedCodRows} from './ops-pulse/cod-pending-data';
import {isAmazonNowStation,isCodReportStation,type PendingStation} from './ops-pulse/cod-pending';
export type CodMailRecipient={email:string;name:string;stationIds:string[];canViewPendingReport?:boolean};
type Membership={user_id:string;role_id:string;has_all_location_access:boolean;location_scope_ids:string[]|null};
type Role={id:string;code:string;location_access_mode:string|null};
type Profile={id:string;email:string|null;full_name:string|null};
export const isAmazonNowMailStation=isAmazonNowStation;
export function resolveCodRecipients(stations:PendingStation[],memberships:Membership[],roles:Role[],profiles:Profile[],permittedRoles:Set<string>,domain:string,stationDirectory:PendingStation[]=stations){
 // Apply the same exclusion when preparing a report and immediately before SMTP.
 // Check the complete master: excluded store mailboxes must stay excluded even
 // when report rows were prefiltered or the account has a wider location scope.
 const excludedMailboxes=new Set(stationDirectory.filter(s=>isAmazonNowStation(s)||s.is_active!==true).map(s=>s.station_email?.trim().toLowerCase()).filter(Boolean));
 const mailStations=stations.filter(isCodReportStation);
 const byEmail=new Map<string,CodMailRecipient>();
 for(const profile of profiles){const email=String(profile.email||'').trim().toLowerCase();if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)||email.split('@')[1]!==domain.toLowerCase())continue;
  if(excludedMailboxes.has(email))continue;
  const userMemberships=memberships.filter(m=>m.user_id===profile.id),userRoles=roles.filter(r=>userMemberships.some(m=>m.role_id===r.id));
  if(!userRoles.some(r=>r.code==='OWNER'||permittedRoles.has(r.id)))continue;
  const all=userMemberships.some(m=>m.has_all_location_access)||userRoles.some(r=>r.location_access_mode==='all_locations'||r.code==='OWNER');
  const ids=new Set(userMemberships.flatMap(m=>m.location_scope_ids||[]));
  const allowed=mailStations.filter(s=>all||ids.has(s.id)||(userRoles.some(r=>r.code==='LOCATION')&&s.station_email?.trim().toLowerCase()===email));
  if(!allowed.length)continue;const prior=byEmail.get(email);byEmail.set(email,{email,name:profile.full_name||email,canViewPendingReport:(prior?.canViewPendingReport!==false)&&!userRoles.some(r=>/(^|_)LOCATION$/.test(r.code.trim().toUpperCase())),stationIds:[...new Set([...(prior?.stationIds||[]),...allowed.map(s=>s.id)])].sort()});
 }
 return [...byEmail.values()];
}
export async function loadCodMailRecipients(db:SupabaseClient,companyId:string,stations:PendingStation[],domain:string){
 const [memberships,roles,profiles,pages,stationDirectory]=await Promise.all([
 pagedCodRows<Membership>(o=>db.from('company_product_memberships').select('user_id,role_id,has_all_location_access,location_scope_ids').eq('company_id',companyId).eq('product_code','operations').eq('is_active',true).order('id').range(o,o+999)),
 pagedCodRows<Role>(o=>db.from('user_roles').select('id,code,location_access_mode').eq('company_id',companyId).eq('is_active',true).order('id').range(o,o+999)),
 pagedCodRows<Profile>(o=>db.from('profiles').select('id,email,full_name').eq('company_id',companyId).eq('is_active',true).order('id').range(o,o+999)),
 pagedCodRows<{id:string}>(o=>db.from('app_pages').select('id').eq('company_id',companyId).eq('is_active',true).in('code',['cod','cod_reports']).order('id').range(o,o+999)),
 pagedCodRows<PendingStation>(o=>db.from('stations').select('id,station_code,station_name,station_email,is_active,hide_from_location_list,providers(code,name),location_models(code,name)').eq('company_id',companyId).order('id').range(o,o+999))]);
 const grants=pages.length?await pagedCodRows<{role_id:string;can_view:boolean;can_edit:boolean}>(o=>db.from('role_page_permissions').select('role_id,can_view,can_edit').eq('company_id',companyId).in('page_id',pages.map(p=>p.id)).order('role_id').order('page_id').range(o,o+999)):[];
 return resolveCodRecipients(stationDirectory.filter(s=>stations.some(candidate=>candidate.id===s.id)),memberships,roles,profiles,new Set(grants.filter(g=>g.can_view||g.can_edit).map(g=>g.role_id)),domain,stationDirectory);
}

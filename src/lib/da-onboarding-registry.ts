import type { AmazonDaPerson } from './amazon-da-desk-types';
export type GuidedDA={id:string;full_name:string;alias_email:string;mobile:string;biometric_id:string;status:string;closed_at:string|null;duplicate_identity_detected:boolean;inbox_status:string;driverId?:string|null;amazonProfileId?:string|null;amazonStatus?:string|null;registration?:string|null;bgc?:string|null;uan?:string|null;learning?:string|null;observedAt?:string|null;syncError?:string|null};
export type DAOwner={is_active?:boolean;designation?:string|null;designation_id?:string|null;id:string;full_name:string;dropx_id:string|null;email:string|null;onboarding_status:string;lifecycle_status?:string|null;provider_employee_id:string|null};
export type DALink={workforce_id:string;amazon_provider_id:string|null;transporter_id:string|null};
export type DARow={key:string;name:string;email:string|null;phone:string|null;amazon:AmazonDaPerson|null;guided:GuidedDA|null;owner:DAOwner|null;conflict:boolean;status:string;next:string;origin:string};
const norm=(s:string|null|undefined)=>(s||'').trim().toLowerCase();
/** Station-scoped inputs only. Never infer ID ownership from a person's name or phone. */
export function mergeDARegistry(amazon:AmazonDaPerson[],guided:GuidedDA[],owners:DAOwner[],links:DALink[]):DARow[]{
 const usedGuided=new Set<string>(),usedOwners=new Set<string>(),rows:DARow[]=[];
 const byOwner=new Map(owners.map(p=>[p.id,p]));
 const unique=[...new Map(amazon.map(p=>[p.providerId,p])).values()];
 function add(a:AmazonDaPerson|null,g:GuidedDA|null,o:DAOwner|null,conflict=false){
  if(g)usedGuided.add(g.id);if(o)usedOwners.add(o.id);
  const status=a?.status||(g?.closed_at?'CLOSED':g?.amazonStatus)||(g?'ONBOARDING':o?.lifecycle_status&&['inactive','offboarded','closed'].includes(o.lifecycle_status)?o.lifecycle_status.toUpperCase():'ID_NOT_LINKED');
  const active=status.toUpperCase()==='ACTIVE',closed=['OFFBOARDED','CLOSED','INACTIVE'].includes(status.toUpperCase());
  const needsReview=conflict||Boolean(g?.duplicate_identity_detected);
  rows.push({key:a?.providerId||g?.id||o!.id,name:a?.name||g?.full_name||o!.full_name,email:a?.email||g?.alias_email||o?.email||null,phone:a?.phone||g?.mobile||null,amazon:a,guided:g,owner:o,conflict:needsReview,status,
   origin:g?'System email':a?'Existing Amazon ID':'Existing registration',
   next:needsReview?'Review identity conflict':!o&&active?'Link DropX owner':closed?'View account history':active?'Account active':g?.syncError?'Check source update':a?.nextAction||a?.stage||(g?.registration==='submitted'?'Review registration':g?'Continue registration':'Review registration / existing ID')});
 }
 for(const a of unique){
  const matches=guided.filter(g=>g.amazonProfileId===a.providerId||Boolean(g.driverId&&g.driverId===a.transporterId)||Boolean(norm(g.alias_email)&&norm(g.alias_email)===norm(a.email)));
  // Duplicate emails/IDs remain separate, visible exceptions; never silently combine people.
  const candidate=matches.length===1?matches[0]:null;
  const contradictory=Boolean(candidate&&((candidate.driverId&&a.transporterId&&candidate.driverId!==a.transporterId)||(candidate.amazonProfileId&&candidate.amazonProfileId!==a.providerId)));
  const multipleAmazonMatches=Boolean(candidate&&unique.filter(p=>p.providerId===candidate.amazonProfileId||Boolean(candidate.driverId&&candidate.driverId===p.transporterId)||Boolean(norm(candidate.alias_email)&&norm(candidate.alias_email)===norm(p.email))).length>1);
  const g=candidate&&!contradictory&&!multipleAmazonMatches&&!usedGuided.has(candidate.id)?candidate:null;
  const ownerIds=new Set(links.filter(l=>l.amazon_provider_id===a.providerId&&(!l.transporter_id||!a.transporterId||l.transporter_id===a.transporterId)).map(l=>l.workforce_id));
  if(g&&byOwner.has(g.id))ownerIds.add(g.id);
  const ownersFound=[...ownerIds].map(id=>byOwner.get(id)).filter((o):o is DAOwner=>!!o);
  add(a,g,ownersFound.length===1?ownersFound[0]:null,matches.length>1||ownerIds.size>1||contradictory||multipleAmazonMatches);
 }
 for(const g of guided)if(!usedGuided.has(g.id))add(null,g,byOwner.get(g.id)||null);
 for(const o of owners)if(!usedOwners.has(o.id))add(null,null,o);
 return rows.sort((a,b)=>Number(b.conflict)-Number(a.conflict)||a.name.localeCompare(b.name));
}
export function daNeedsAttention(row:DARow){return row.conflict||(!row.owner&&row.status==='ACTIVE')||Boolean(row.guided?.syncError)||/behind|blocked|error|failed/i.test(row.amazon?.health||row.guided?.status||'');}

import type { AmazonDaPerson } from './amazon-da-desk-types';
export type GuidedDA={id:string;full_name:string;alias_email:string;mobile:string;biometric_id:string;status:string;closed_at:string|null;duplicate_identity_detected:boolean;inbox_status:string;driverId?:string|null;amazonProfileId?:string|null;amazonStatus?:string|null;registration?:string|null;bgc?:string|null;uan?:string|null;learning?:string|null;observedAt?:string|null;syncError?:string|null};
export type DAOwner={mobile?:string|null;source_profile_type?:string;source_profile_id?:string|null;is_active?:boolean;designation?:string|null;designation_id?:string|null;id:string;full_name:string;dropx_id:string|null;email:string|null;onboarding_status:string;lifecycle_status?:string|null;provider_employee_id:string|null};
export type DALink={workforce_id:string;amazon_provider_id:string|null;transporter_id:string|null};
export type DARow={key:string;name:string;email:string|null;phone:string|null;amazon:AmazonDaPerson|null;guided:GuidedDA|null;owner:DAOwner|null;linkedAmazon?:AmazonDaPerson[];setup?:DASetup;conflict:boolean;status:string;next:string;origin:string};
export type DASetup={mapping:'confirmed'|'pending'|'unknown';rateCard:'configured'|'pending'|'unknown';rateCardLabel?:string|null;checkedAt:string};
const norm=(s:string|null|undefined)=>(s||'').trim().toLowerCase();
/** One row per DropX identity. Provider-only records belong exclusively to Amazon status. */
export function mergeDARegistry(amazon:AmazonDaPerson[],guided:GuidedDA[],owners:DAOwner[],links:DALink[]):DARow[]{
 const unique=[...new Map(amazon.map(p=>[p.providerId,p])).values()];
 const byOwner=new Map(owners.map(p=>[p.id,p]));
 const guidedById=new Map(guided.map(g=>[g.id,g]));
 const identities=[...owners.map(o=>({o,g:guidedById.get(o.id)||null})),...guided.filter(g=>!byOwner.has(g.id)).map(g=>({o:null,g}))];
 return identities.map(({o,g}):DARow=>{
  const explicit=links.filter(l=>l.workforce_id===o?.id);
  const candidates=unique.filter(a=>explicit.some(l=>l.amazon_provider_id===a.providerId)||Boolean(g&&(g.amazonProfileId===a.providerId||g.driverId&&g.driverId===a.transporterId||norm(g.alias_email)&&norm(g.alias_email)===norm(a.email))));
  let conflict=Boolean(g?.duplicate_identity_detected);
  const linked=candidates.filter(a=>{
   const ownerIds=new Set(links.filter(l=>l.amazon_provider_id===a.providerId).map(l=>l.workforce_id));
   const guidedMatches=guided.filter(c=>c.amazonProfileId===a.providerId||Boolean(c.driverId&&c.driverId===a.transporterId)||Boolean(norm(c.alias_email)&&norm(c.alias_email)===norm(a.email)));
   const mismatched=explicit.some(l=>l.amazon_provider_id===a.providerId&&l.transporter_id&&a.transporterId&&l.transporter_id!==a.transporterId)||Boolean(g&&((g.driverId&&a.transporterId&&g.driverId!==a.transporterId)||(g.amazonProfileId&&g.amazonProfileId!==a.providerId)));
   const ambiguous=ownerIds.size>1||Boolean(ownerIds.size&&g&&![...ownerIds].includes(g.id))||guidedMatches.length>1||Boolean(g&&candidates.length>1);
   if(mismatched||ambiguous){conflict=true;return false;}return true;
  });
  // Deterministic display only; retain all confirmed linked IDs under this single DropX record.
  linked.sort((a,b)=>Number(b.status==='ACTIVE')-Number(a.status==='ACTIVE')||a.providerId.localeCompare(b.providerId));
  const a=linked[0]||null,lifecycle=(o?.lifecycle_status||'').toLowerCase();
  const status=['offboarded','closed','exited','cancelled'].includes(lifecycle)||(!o&&g?.closed_at)?'OFFBOARDED':
   ['inactive','suspended','offboarding','resignation_pending'].includes(lifecycle)||(o?.onboarding_status==='active'&&o.is_active===false)?'INACTIVE':
   o?.onboarding_status==='active'&&o.is_active===true?'ACTIVE':'ONBOARDING';
  return {key:o?.id||g!.id,name:o?.full_name||g!.full_name,email:g?.alias_email||o?.email||null,phone:o?.mobile||g?.mobile||null,
   amazon:a,linkedAmazon:linked,guided:g,owner:o,conflict,status,origin:g?'System invitation':'Existing DropX profile',next:conflict?'Review identity link':status==='ACTIVE'?'Check setup progress':'Complete DropX registration'};
 }).sort((a,b)=>Number(b.conflict)-Number(a.conflict)||a.name.localeCompare(b.name));
}
export function linkedAmazonProfiles(row:DARow){return row.linkedAmazon?.length?row.linkedAmazon:row.amazon?[row.amazon]:[];}
export function daNeedsAttention(row:DARow){return row.conflict||Boolean(row.guided?.syncError)||/behind|blocked|error|failed/i.test(row.amazon?.health||row.guided?.status||'');}

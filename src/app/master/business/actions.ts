'use server';
import {revalidatePath} from 'next/cache';
import {financeContext,canWritePricing} from '@/lib/finance/data';
import {loadBusinessMaster,locationModel} from '@/lib/finance/business-master';
import {validateMaster,type BusinessMasterKind} from '@/lib/finance/now';
export async function saveBusinessMaster(input:{kind:BusinessMasterKind;key:string;label:string;data:unknown;revision:number;remove?:boolean}) {
 try {
  const c=await financeContext('finance_pricing');
  if(!c.authorization.hasAllLocationAccess||!canWritePricing(c.authorization,input.revision))throw Error('Company-wide Finance master access is required.');
  if(!/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.key)||!input.label?.trim()||input.label.length>200||!Number.isInteger(input.revision)||input.revision<0)throw Error('Enter a valid record key and name.');
  const data=validateMaster(input.kind,input.data),records=await loadBusinessMaster(c);
  const code=data.station_code;
  if(code&&!c.locations.some(l=>l.station_code===code))throw Error('Choose an existing location.');
  if(input.kind==='reporting_region'&&input.key!==code)throw Error('Region mapping key must be the station code.');
  if(input.kind==='now_store'){
   if(!c.locations.some(l=>l.station_code===code&&locationModel(l)==='NOW'))throw Error('Choose an Amazon Now store.');
   const rate=records.find(r=>r.kind==='now_rate'&&r.key===data.rate_key);
   if(!rate||rate.data.category!==data.category||rate.data.city!==data.city)throw Error('Category and city must match the selected rate card.');
  }
  if(input.kind==='overhead'){
   if(!c.locations.some(l=>l.station_code===code&&l.is_ho))throw Error('Choose an HO location.');
   if(data.recipient_codes.some((s:string)=>!c.locations.some(l=>l.station_code===s&&!l.is_ho)))throw Error('Choose operating locations as recipients.');
  }
  if(input.kind==='contract'&&!records.some(r=>r.kind==='cost_head'&&r.key===data.head_key))throw Error('Create or select an expense head first.');
  if(input.remove&&records.some(r=>(input.kind==='now_rate'&&r.kind==='now_store'&&r.data.rate_key===input.key)||(input.kind==='cost_head'&&r.kind==='contract'&&r.data.head_key===input.key)))throw Error('This record is in use. Reassign its linked records before deleting.');
  // One dated store/rule at a time; overlapping price definitions are ambiguous.
  if(!input.remove&&['now_store','overhead'].includes(input.kind)&&records.some(r=>r.kind===input.kind&&r.key!==input.key&&r.data.station_code===code&&r.data.effective_from<=(data.effective_to||'9999-12-31')&&(r.data.effective_to||'9999-12-31')>=data.effective_from))throw Error('Effective dates overlap an existing record for this location.');
  const r=await c.db.rpc('finance_save_business_master',{p_company:c.companyId,p_actor:c.authorization.userId,p_kind:input.kind,p_key:input.key,p_label:input.label.trim(),p_data:data,p_revision:input.revision,p_delete:!!input.remove});
  if(r.error)throw Error(r.error.message.includes('Record changed')?'This record changed. Reload before saving.':'Unable to save. No changes were applied.');
  revalidatePath('/master/business');revalidatePath('/finance/profitability');return {ok:true as const};
 }catch(e){return {ok:false as const,error:e instanceof Error?e.message:'Unable to save.'};}
}

'use server';
import {revalidatePath} from 'next/cache';
import {financeContext,canWritePricing} from '@/lib/finance/data';
import {locationModel} from '@/lib/finance/business-master';
import {validateNowVolume} from '@/lib/finance/now';
import {todayIndia} from '@/lib/finance/pricing';
export async function saveNowVolumes(input:unknown[]){try{
 const c=await financeContext('finance_revenue');
 if(!Array.isArray(input)||!input.length||input.length>500)throw Error('Enter 1–500 rows.');
 const seen=new Set<string>();const rows=input.map(x=>{const row=validateNowVolume(x),revision=Number((x as any).revision??0);if(!Number.isInteger(revision)||revision<0||!canWritePricing(c.authorization,revision))throw Error('Pricing add/edit permission is required.');if(row.through_date>todayIndia())throw Error('Data through cannot be in the future.');if(!c.locations.some(l=>l.station_code===row.station_code&&locationModel(l)==='NOW'))throw Error('Store is outside your Amazon Now location access.');const key=row.station_code+'/'+row.month;if(seen.has(key))throw Error('Duplicate store and month.');seen.add(key);return {...row,revision};});
 const r=await c.db.rpc('finance_save_now_volumes',{p_company:c.companyId,p_actor:c.authorization.userId,p_rows:rows});if(r.error)throw Error(r.error.message.includes('Volume changed')?'Data changed. Reload and review before saving.':'Import could not be saved. No rows were changed.');revalidatePath('/finance/now-volumes');revalidatePath('/finance/profitability');return {ok:true as const};
 }catch(e){return {ok:false as const,error:e instanceof Error?e.message:'Unable to save.'};}}

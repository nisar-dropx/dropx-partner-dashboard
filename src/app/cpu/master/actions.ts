'use server';
import {revalidatePath} from 'next/cache';
import {requirePagePermission,hasPermission} from '@/lib/authorization';
import {darkStoreScope} from '@/lib/ops-pulse/dark-store';
import {validateNowVolume} from '@/lib/finance/now';
import {todayKolkata} from '@/lib/ops-pulse/cod';
export async function saveNowVolumes(input:unknown[]){try{
 const a=await requirePagePermission('cps_inputs','access'),c=await darkStoreScope(a);
 if(!Array.isArray(input)||!input.length||input.length>500)throw Error('Enter 1–500 rows.');
 const seen=new Set<string>();const rows=input.map(x=>{const row=validateNowVolume(x),revision=Number((x as any).revision||0);if(!Number.isInteger(revision)||revision<0||!hasPermission(a,'cps_inputs',revision?'edit':'add'))throw Error('CPU Master add/edit permission is required.');if(!c.locations.some(l=>l.station_code===row.station_code)||row.through_date>todayKolkata())throw Error('Check store access and data-through date.');const k=row.station_code+'/'+row.month;if(seen.has(k))throw Error('Duplicate store/month.');seen.add(k);return {...row,revision};});
 const r=await c.db.rpc('finance_save_now_volumes',{p_company:c.companyId,p_actor:a.userId,p_rows:rows});if(r.error)throw Error('Unable to save. Reload if another user changed these units.');revalidatePath('/cpu');revalidatePath('/cpu/master');return {ok:true as const};
 }catch(e){return {ok:false as const,error:e instanceof Error?e.message:'Save failed.'};}}

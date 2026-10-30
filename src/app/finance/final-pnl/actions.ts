'use server';
import {revalidatePath} from 'next/cache';
import {finalContext,worker} from '@/lib/finance/final-pnl/server';
import {loadSources} from '@/lib/finance/final-pnl/sources';
import {monthValue} from '@/lib/finance/final-pnl/model';
export async function syncMonth(month:string){try{const ctx=await finalContext('edit');monthValue(month);await worker(ctx.companyId,'invoices/refresh',{});const sources=await loadSources(ctx.db,ctx.companyId,month);await worker(ctx.companyId,'sync',sources);revalidatePath('/finance/final-pnl');return {ok:true,message:'Invoices, final expenses and loss evidence refreshed.'};}catch(e){return {ok:false,message:e instanceof Error?e.message:'Refresh failed.'};}}
export async function saveChange(data:{month:string;id:string;kind:'entry'|'schedule';version:number;deleted?:boolean;reason:string;value:unknown}){
 try{const ctx=await finalContext(data.version===0&&data.id.startsWith('manual:')||data.version===0&&data.id.startsWith('schedule:')?'add':'edit');monthValue(data.month);await worker(ctx.companyId,'change',{...data,actor:ctx.authorization.userId});revalidatePath('/finance/final-pnl');return {ok:true,message:data.deleted?'Entry removed from totals; its history is retained.':'Saved with correction history.'};}catch(e){return {ok:false,message:e instanceof Error?e.message:'Save failed.'};}
}
export async function saveOverhead(data:{month:string;pool:string;method:string;recipients:string[];weights:Record<string,number>;version:number;reason:string}){
 try{const ctx=await finalContext('edit');monthValue(data.month);await worker(ctx.companyId,'overhead',{...data,actor:ctx.authorization.userId});revalidatePath('/finance/final-pnl');return {ok:true,message:'HO allocation saved for this month with correction history.'};}catch(e){return {ok:false,message:e instanceof Error?e.message:'Allocation failed.'};}
}

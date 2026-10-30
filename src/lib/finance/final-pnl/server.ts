import 'server-only';
import {financeContext} from '@/lib/finance/data';
import {hasPermission} from '@/lib/authorization';
import {redirect} from 'next/navigation';
import {FINAL_PNL_COMPANY} from './sources';
export async function finalContext(write?:'add'|'edit'){
 const ctx=await financeContext('finance_pnl');
 if(!ctx.authorization.hasAllLocationAccess)redirect('/unauthorized?page=finance_pnl_company_scope');
 if(ctx.companyId!==FINAL_PNL_COMPANY)throw Error('Final P&L is not connected for this company.');
 if(write&&!hasPermission(ctx.authorization,'finance_pnl',write))throw Error('Your role cannot make this P&L change.');
 return ctx;
}
export async function worker<T>(company:string,path:string,payload?:unknown):Promise<T>{
 const key=process.env.FIN_PNL_API_KEY;if(!key)throw Error('Final P&L connection is not configured.');
 const response=await fetch(`https://finance-worker.withered-voice-1c40.workers.dev/api/fin/pnl/${path}`,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json','x-fin-key':key,'x-company-id':company},body:payload?JSON.stringify(payload):undefined,cache:'no-store',signal:AbortSignal.timeout(150000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||`P&L connection failed (${response.status}).`);return result;
}

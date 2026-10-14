import {AppShell} from '@/components/app-shell';
import {hasPermission} from '@/lib/authorization';
import {finalContext,worker} from '@/lib/finance/final-pnl/server';
import {monthValue,previousMonth,type Report} from '@/lib/finance/final-pnl/model';
import {FinalPnlWorkspace} from './workspace';
import './final-pnl.css';
export const dynamic='force-dynamic';export const maxDuration=300;
export default async function Page({searchParams={}}:{searchParams?:{month?:string;station?:string}}){
 const ctx=await finalContext();let month=previousMonth();try{if(searchParams.month)month=monthValue(searchParams.month);}catch{/* invalid URL defaults to last completed month */}
 let report:Report|null=null,error='';try{report=await worker<Report>(ctx.companyId,`report?month=${month}`);}catch(e){error=e instanceof Error?e.message:'Unable to load final P&L.';}
 return <AppShell active="Final P&L" pageCode="finance_pnl"><FinalPnlWorkspace key={month} month={month} report={report} error={error} initialStation={searchParams.station??''} canAdd={hasPermission(ctx.authorization,'finance_pnl','add')} canEdit={hasPermission(ctx.authorization,'finance_pnl','edit')}/></AppShell>;
}

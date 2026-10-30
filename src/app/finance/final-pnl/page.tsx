import {AppShell} from '@/components/app-shell';
import {hasPermission} from '@/lib/authorization';
import {loadSources} from '@/lib/finance/final-pnl/sources';
import {finalContext,worker} from '@/lib/finance/final-pnl/server';
import {monthValue,previousMonth,type Report} from '@/lib/finance/final-pnl/model';
import {FinalPnlWorkspace} from './workspace';
import './final-pnl.css';
export const dynamic='force-dynamic';export const maxDuration=300;
export default async function Page({searchParams={}}:{searchParams?:{month?:string;station?:string}}){
 const ctx=await finalContext();let month=previousMonth();try{if(searchParams.month)month=monthValue(searchParams.month);}catch{/* invalid URL defaults to last completed month */}
 let report:Report|null=null,error='';try{report=await worker<Report>(ctx.companyId,`report?month=${month}`);}catch(e){error=e instanceof Error?e.message:'Unable to load final P&L.';}
 const canEdit=hasPermission(ctx.authorization,'finance_pnl','edit');
 if(report?.capturedAt&&(report.counts.schemaVersion??0)<5&&!canEdit)report={...report,issues:['Saved source coverage needs an update. Ask a Finance editor to refresh sources before treating this month as final.',...report.issues]};
 if(report?.capturedAt&&(report.counts.schemaVersion??0)<5&&canEdit){try{await worker(ctx.companyId,'sync',await loadSources(ctx.db,ctx.companyId,month));report=await worker<Report>(ctx.companyId,`report?month=${month}`);}catch(e){report={...report,issues:[`New salary and expense detail coverage could not refresh: ${e instanceof Error?e.message:'Source unavailable'}. The prior saved report is shown.`,...report.issues]};}}
 return <AppShell active="Final P&L" pageCode="finance_pnl"><FinalPnlWorkspace key={month} month={month} report={report} error={error} initialStation={searchParams.station??''} canAdd={hasPermission(ctx.authorization,'finance_pnl','add')} canEdit={canEdit}/></AppShell>;
}

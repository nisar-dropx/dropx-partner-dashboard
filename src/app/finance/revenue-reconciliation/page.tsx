import {AppShell} from '@/components/app-shell';
import {finalContext} from '@/lib/finance/final-pnl/server';
import {monthValue,previousMonth} from '@/lib/finance/final-pnl/model';
import {todayIndia} from '@/lib/finance/pricing';
import {loadBillingAudit} from '@/lib/finance/billing-audit/server';
import {BillingWorkspace} from './workspace';
import '../cfo.css';
import '../business/pnl.css';
import './style.css';
export const dynamic='force-dynamic';
export const maxDuration=300;
export default async function Page({searchParams={}}:{searchParams?:{month?:string}}){
 const ctx=await finalContext();
 let month=previousMonth();try{if(searchParams.month){const value=monthValue(searchParams.month);if(value<=todayIndia().slice(0,7))month=value;}}catch{/* Use last completed month. */}
 let report:null|Awaited<ReturnType<typeof loadBillingAudit>>=null,error='';
 try{report=await loadBillingAudit(ctx,month);}catch(e){console.error('Billing audit load failed',e instanceof Error?e.message:'Source unavailable');error='The billing comparison could not be loaded. Please retry.';}
 return <AppShell active="Live provisional P&L" pageCode="finance_pnl">{report?<BillingWorkspace report={report}/>:<div className="cfo"><h1>Revenue reconciliation</h1><p role="alert">{error}</p><a href={`?month=${month}`}>Retry</a></div>}</AppShell>;
}

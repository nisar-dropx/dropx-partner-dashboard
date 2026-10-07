import Link from 'next/link';
import {AppShell} from '@/components/app-shell';
import {financeContext,type Query} from '@/lib/finance/data';
import {loadCfo} from '@/lib/finance/cfo-data';
import {CfoWorkspace} from './workspace';
import '../cfo.css';
import '../business/pnl.css';
import './detail.css';
export const dynamic='force-dynamic';
export const maxDuration=300;
export default async function Page({searchParams={}}:{searchParams?:Query}){
 const retryParams=new URLSearchParams();
 for(const key of ['period','month','from','to','model','region','cluster','location','overhead']){const value=searchParams[key];if(typeof value==='string')retryParams.set(key,value.slice(0,100));}
 const retryHref='/finance/profitability'+(retryParams.size?'?'+retryParams.toString():'');
 const c=await financeContext('finance_pnl');let report;try{report=await loadCfo(c,searchParams);}catch(e){console.error('Finance profitability load',e instanceof Error?e.message:e);return <AppShell active="Profit & Loss" pageCode="finance_pnl"><div className="cfo"><h1>Business profitability</h1><p role="alert">{e instanceof Error?e.message:'Unable to load. Please retry.'}</p><Link prefetch={false} href={retryHref}>Retry</Link></div></AppShell>;}
 return <AppShell active="Profit & Loss" pageCode="finance_pnl"><CfoWorkspace key={JSON.stringify([report.filters,report.viewFilters])} report={report}/></AppShell>;
}

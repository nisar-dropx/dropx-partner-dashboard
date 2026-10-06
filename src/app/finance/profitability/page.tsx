import Link from 'next/link';
import {AppShell} from '@/components/app-shell';
import {financeContext,type Query} from '@/lib/finance/data';
import {loadCfo} from '@/lib/finance/cfo-data';
import {CfoWorkspace} from './workspace';
import '../cfo.css';
export const dynamic='force-dynamic';
export const maxDuration=300;
export default async function Page({searchParams={}}:{searchParams?:Query}){
 const c=await financeContext('finance_pnl');let report;try{report=await loadCfo(c,searchParams);}catch(e){console.error('Finance profitability load',e instanceof Error?e.message:e);return <AppShell active="Profit & Loss" pageCode="finance_pnl"><div className="cfo"><h1>Business profitability</h1><p role="alert">{e instanceof Error?e.message:'Unable to load. Please retry.'}</p><Link href="/finance/profitability">Retry</Link></div></AppShell>;}
 return <AppShell active="Profit & Loss" pageCode="finance_pnl"><CfoWorkspace key={JSON.stringify(report.filters)} report={report}/></AppShell>;
}

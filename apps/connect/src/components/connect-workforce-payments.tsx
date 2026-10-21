"use client";
import {CalendarDays,ChevronDown,ChevronLeft,ChevronRight,IndianRupee,ReceiptText,RefreshCw,Route,WalletCards} from 'lucide-react';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import type {AppAccount} from './connect-profile-app';
import {ConnectAdvances} from './connect-advances';
import {ConnectPayAdjustments} from './connect-pay-adjustments';
import {ConnectPayIncentives} from './connect-pay-incentives';
import {ConnectRouteFuel} from './connect-route-fuel';
import type {RouteGeometry} from './connect-route-map';
import {createRoutePreviewCache} from '@/lib/route-preview-cache';
import type {DailyRouteFuel} from '../../../../src/lib/workforce-route-distance';
import type {OwnAdjustmentLedger} from '@/lib/workforce-own-adjustments';
import type {OwnIncentiveSummary} from '@/lib/workforce-own-incentives';
import type {PaymentReference} from '@/lib/payment-reference';
import {reconcileOwnProduction,type OwnProductionDay} from '@/lib/own-production-breakdown';
import {AssociatePayouts} from './associate-payouts';
import {ConnectLossRecoveries} from './connect-loss-recoveries';
import {currentPayoutMonth,normalizePayoutMonth,payoutMonthLabel,payoutMonthLongLabel,shiftPayoutMonth} from '@/lib/payout-dispute';
import monthStyles from './payout-month-control.module.css';
import styles from './connect-workforce-payments.module.css';

type Daily=OwnProductionDay&{production:Array<{label:string;unit?:string;count:number;rate:number;amount:number}>};
type EarningsData={month:string;routeFuel?:DailyRouteFuel[];summary:{workDays:number;grossAmount:number;netAmount:number;baseAmount:number;incentiveAmount:number;additions:number;deductionAmount:number};adjustments:OwnAdjustmentLedger;incentives:OwnIncentiveSummary;earnings:Array<{id:string;location:string;paymentMethod:string;daily:Daily[]}>};
type Tab='earnings'|'statements'|'advances'|'rate-card';
const money=(n:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
const date=(d:string)=>new Date(`${d}T00:00:00`).toLocaleDateString('en-IN',{day:'numeric',month:'short'});
export function ConnectWorkforcePayments({account}:{account:AppAccount}){
 return <WorkforcePayments key={`${account.companyId}:${account.profileType}:${account.id}:${account.pageAccess?.join(',')}`} account={account}/>;
}
function WorkforcePayments({account}:{account:AppAccount}){
 const searchParams=useSearchParams(),access=account.pageAccess??[];
 const earningsAllowed=access.includes('earnings'),advancesAllowed=access.includes('advances');
 // Own mapped rates are already part of the earnings permission on the server.
 const rateCardAllowed=earningsAllowed||access.includes('rate_card');
 const firstTab:Tab=searchParams.get('tab')==='payouts'&&earningsAllowed?'statements':earningsAllowed?'earnings':advancesAllowed?'advances':'rate-card';
 const [tab,setTab]=useState<Tab>(firstTab),[month,setMonth]=useState(normalizePayoutMonth(searchParams.get('payoutMonth'))??currentPayoutMonth());
 const [calculated,setCalculated]=useState<EarningsData|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [reference,setReference]=useState<PaymentReference|null>(null),[referenceLoading,setReferenceLoading]=useState(false),[referenceError,setReferenceError]=useState('');
 const [expandedDate,setExpandedDate]=useState(''),[payoutLocked,setPayoutLocked]=useState(false),[payoutVisited,setPayoutVisited]=useState(firstTab==='statements');
 const generation=useRef(0),monthCache=useRef(new Map<string,{at:number;data:EarningsData}>());
 const routeCache=useRef(createRoutePreviewCache<RouteGeometry>());
 const load=useCallback(async(force=false)=>{
  const version=++generation.current,cached=monthCache.current.get(month);
  setError('');setExpandedDate('');
  if(!force&&cached&&Date.now()-cached.at<60000){setCalculated(cached.data);setLoading(false);return;}
  setCalculated(null);setLoading(true);
  try{
   const query=new URLSearchParams({accountId:account.id,profileType:account.profileType,month});
   const response=await fetch(`/api/connect/earnings?${query}`,{cache:'no-store',signal:AbortSignal.timeout(25000)});
   const result=await response.json() as EarningsData&{error?:string};
   if(!response.ok)throw new Error(result.error||'Unable to load earnings.');
   if(result.month!==month||!result.adjustments||!Array.isArray(result.incentives?.campaigns))throw new Error('Your payment estimate could not be verified.');
   reconcileOwnProduction(result.earnings,result.summary);
   if(version!==generation.current)return;
   monthCache.current.set(month,{at:Date.now(),data:result});if(monthCache.current.size>3)monthCache.current.delete(monthCache.current.keys().next().value!);
   setCalculated(result);
  }catch(e){if(version===generation.current)setError(e instanceof Error&&e.name!=='TimeoutError'?e.message:'Earnings are taking longer than usual. Please retry.');}
  finally{if(version===generation.current)setLoading(false);}
 },[account.id,account.profileType,month]);
 useEffect(()=>{if(tab!=='earnings'||!earningsAllowed)return;void load();return()=>{generation.current++;};},[load,tab,earningsAllowed]);
 const loadReference=useCallback(async()=>{
  setReferenceLoading(true);setReferenceError('');
  try{
   const q=new URLSearchParams({accountId:account.id,profileType:account.profileType});
   const response=await fetch(`/api/connect/payment-reference?${q}`,{cache:'no-store',signal:AbortSignal.timeout(20000)}),body=await response.json();
   if(!response.ok||!Array.isArray(body.cards))throw new Error(body.error||'Unable to load your rate card.');
   setReference(body);
  }catch(e){setReferenceError(e instanceof Error&&e.name!=='TimeoutError'?e.message:'Rate cards are taking longer than usual. Please retry.');}
  finally{setReferenceLoading(false);}
 },[account.id,account.profileType]);
 useEffect(()=>{if(tab==='rate-card'&&!reference&&!referenceLoading&&!referenceError)void loadReference();},[tab,reference,referenceLoading,referenceError,loadReference]);
 const daily=useMemo(()=>calculated?reconcileOwnProduction(calculated.earnings,calculated.summary):[],[calculated]);
 const fuels=calculated?.routeFuel??[],pending=fuels.some(f=>f.status==='pending');
 const changeTab=(next:Tab)=>{setTab(next);if(next==='statements')setPayoutVisited(true);};
 return <section className={`dx-workforce-payments ${styles.page}`}>
  <div className={styles.headingRow}>
   <header className="dx-page-intro"><small>My pay</small><h1>Payments</h1><p>Your earnings, payouts and agreed rates.</p></header>
   {earningsAllowed&&tab!=='rate-card'?<div className={monthStyles.monthPicker}><span>Payment month</span><div className={monthStyles.monthControl} role="group" aria-label="Earnings and payout month">
    <button type="button" aria-label="Previous earnings and payout month" disabled={(tab==='statements'&&payoutLocked)||loading} onClick={()=>setMonth(m=>shiftPayoutMonth(m,-1))}><ChevronLeft/></button>
    <strong aria-live="polite"><span aria-hidden="true">{payoutMonthLabel(month)}</span><span className={monthStyles.srOnly}>Showing earnings and payouts for {payoutMonthLongLabel(month)}</span></strong>
    <button type="button" aria-label="Next earnings and payout month" disabled={month>=currentPayoutMonth()||(tab==='statements'&&payoutLocked)||loading} onClick={()=>setMonth(m=>shiftPayoutMonth(m,1))}><ChevronRight/></button>
   </div></div>:null}
  </div>
  <nav aria-label="Payment section" className={`dx-workforce-tabs ${styles.tabs}`}>
   {earningsAllowed?<button className={tab==='earnings'?'active':''} onClick={()=>changeTab('earnings')}><IndianRupee/>Live earnings</button>:null}
   {earningsAllowed?<button className={tab==='statements'?'active':''} onClick={()=>changeTab('statements')}><ReceiptText/>Payouts</button>:null}
   {rateCardAllowed?<button className={tab==='rate-card'?'active':''} onClick={()=>changeTab('rate-card')}><WalletCards/>Rate card</button>:null}
   {advancesAllowed?<button className={tab==='advances'?'active':''} onClick={()=>changeTab('advances')}><IndianRupee/>Advances</button>:null}
  </nav>
  {tab==='advances'&&advancesAllowed?<ConnectAdvances account={account}/>:null}
  {payoutVisited&&earningsAllowed?<div hidden={tab!=='statements'}><AssociatePayouts accountId={account.id} profileType={account.profileType} month={month} onMonthLockChange={setPayoutLocked}/></div>:null}
  {tab==='earnings'&&earningsAllowed?<>
   {loading||(!error&&calculated?.month!==month)?<div className="dx-loader"><span/><small>Loading saved earnings…</small></div>:error?<div role="alert" className="dx-alert error">{error}<button onClick={()=>void load(true)}>Retry</button></div>:calculated?<>
    <section className="dx-workforce-payment-hero"><span><small>{payoutMonthLongLabel(month)}</small><strong>{money(calculated.summary.netAmount)}</strong><em>{pending?'Known earnings · fuel pending':'Estimated live earnings'}</em></span><button onClick={()=>changeTab('rate-card')}>View rate card <ChevronRight/></button></section>
    <p className={styles.note}>Base pay and allowances {money(calculated.summary.baseAmount)} · Incentives {money(calculated.summary.incentiveAmount)} · Adjustments {money(calculated.summary.additions-calculated.summary.deductionAmount)}</p>
    <section className="dx-workforce-payment-stats"><article><CalendarDays/><span><strong>{calculated.summary.workDays}</strong><small>Eligible work days</small></span></article>{fuels.length?<><article><Route/><span><strong>{fuels.filter(f=>f.status==='ready').reduce((n,f)=>n+(f.km??0),0).toLocaleString('en-IN',{maximumFractionDigits:2})} km</strong><small>Recorded fuel distance</small></span></article><article><IndianRupee/><span><strong>{money(fuels.reduce((n,f)=>n+(f.amount??0),0))}</strong><small>Known KM fuel allowance</small></span></article></>:<article><Route/><span><strong>{daily.reduce((n,d)=>n+d.deliveries,0)}</strong><small>Recorded deliveries</small></span></article>}</section>
    <ConnectPayAdjustments ledger={calculated.adjustments}/><ConnectPayIncentives incentives={calculated.incentives}/>
    <ConnectLossRecoveries accountId={account.id} profileType={account.profileType}/>
    <section className={`dx-workforce-ledger ${styles.ledger}`}><header><h2>Daily earnings</h2><button type="button" onClick={()=>void load(true)} aria-label="Refresh earnings"><RefreshCw/></button></header>
     {daily.length?<div>{daily.map(day=>{
      const dayFuels=fuels.filter(f=>f.date===day.date),dayMappings=calculated.earnings.filter(e=>e.daily.some(d=>d.date===day.date));
      const salary=dayMappings.some(e=>e.daily.some(d=>d.date===day.date&&['provider_attendance','direct_allocation'].includes(d.calculationSource)));
      return <article key={day.date} className={expandedDate===day.date?'expanded':''}><button type="button" className="dx-workforce-day" aria-expanded={expandedDate===day.date} onClick={()=>setExpandedDate(d=>d===day.date?'':day.date)}><span><strong>{date(day.date)}</strong><small>{salary?`Attendance pay${day.deliveries?` · ${day.deliveries} deliveries`:''}`:`${day.deliveries} deliveries`}{dayFuels.length?` · ${dayFuels.some(f=>f.status==='pending')?'Fuel pending':`${dayFuels.reduce((n,f)=>n+(f.km??0),0).toFixed(2)} km`}`:''}</small></span><b>{money(day.amount)}<ChevronDown/></b></button>
       {expandedDate===day.date?<div className={styles.dayDetail}>
        {dayMappings.map(e=><section className={styles.dayLines} key={e.id}><header><strong>{e.paymentMethod}</strong><small>{e.location}</small></header>{e.daily.filter(d=>d.date===day.date&&!d.production?.length).map(d=><div key={d.id}><span>{d.payType==='fixed_monthly'?'Monthly salary · daily share':d.payType==='fixed_daily'?'Daily guaranteed pay':'Pay under your assigned rate card'}</span><strong>{money(d.baseAmount)}</strong></div>)}{e.daily.filter(d=>d.date===day.date).flatMap(d=>d.production??[]).filter(l=>(l.amount!==0||l.count>0)&&l.unit!=='km'&&!/fuel allowance.*km/i.test(l.label)).map((l,i)=><div key={i}><span>{l.label}<small className={styles.lineBasis}>{l.unit==='monthly'?`Monthly rate ${money(l.rate)} · eligible attendance`:l.unit?`${l.count.toLocaleString('en-IN',{maximumFractionDigits:4})} ${l.unit} × ${money(l.rate)}`:'Calculated under your assigned rate card'}</small></span><strong>{money(l.amount)}</strong></div>)}</section>)}
        {day.incentiveAmount>0?<p className={styles.dayTotal}><span>Incentives</span><strong>{money(day.incentiveAmount)}</strong></p>:null}
        <ConnectRouteFuel account={account} fuels={dayFuels} cache={routeCache.current}/>
        <p className={styles.dayTotal}><span>{dayFuels.some(f=>f.status==='pending')?'Known total · fuel pending':'Day total'}</span><strong>{money(day.amount)}</strong></p>
       </div>:null}
      </article>;
     })}</div>:<div className="dx-empty"><ReceiptText/><strong>No earnings recorded for this month</strong></div>}
    </section>
   </>:null}
  </>:null}
  {tab==='rate-card'&&rateCardAllowed?<section className={styles.rateSection}>
   <header><div><small>YOUR AGREED RATES</small><h2>My rate card</h2><p>Salary, activity pay and allowances assigned to you.</p></div><button type="button" aria-label="Refresh rate card" disabled={referenceLoading} onClick={()=>void loadReference()}><RefreshCw/></button></header>
   {referenceLoading?<p role="status">Loading your assigned rates…</p>:referenceError?<p role="alert">{referenceError}<button onClick={()=>void loadReference()}>Retry</button></p>:reference?<>
    <p className={styles.note}>Active on {date(reference.asOf)}. Published payouts keep the rates used for that pay period.</p>
    {!reference.cards.length?<p>No active rate card is assigned. Your Workforce team can update your payment mapping.</p>:reference.cards.map(card=><article className={styles.rateAllocation} key={card.id}><header><div><h3>{card.name}</h3><span>{card.station}{card.providerId?` · Provider ID ${card.providerId}`:''}</span></div><small>{date(card.from)}{card.to?` – ${date(card.to)}`:' onward'}</small></header><div className={styles.rateGrid}>{card.lines.map((line,i)=><div className={styles.rateTile} key={`${line.code}:${i}`}><small>{line.label}</small><strong>{money(line.rate)}</strong><span>{line.unit}</span>{line.overrideFrom?<em>Updated rate: {date(line.overrideFrom)} – {date(line.overrideTo!)}</em>:null}{line.rate===0?<em>No separate payment under this head</em>:null}</div>)}</div></article>)}
   </>:null}
  </section>:null}
 </section>;
}

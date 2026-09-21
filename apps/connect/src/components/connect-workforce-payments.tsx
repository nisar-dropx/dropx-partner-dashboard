"use client";

import { CalendarDays, ChevronDown, ChevronRight, Download, IndianRupee, ReceiptText, RefreshCw, Route, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppAccount } from "./connect-profile-app";
import { ConnectAdvances } from "./connect-advances";
import { ConnectWorkforceJoining } from "./connect-workforce-joining";
import {ConnectPayAdjustments} from './connect-pay-adjustments';
import type {OwnAdjustmentLedger} from '@/lib/workforce-own-adjustments';
import {paymentSectionResult} from '@/lib/payment-section-result';
import {ConnectPayIncentives} from './connect-pay-incentives';
import type {OwnIncentiveSummary} from '@/lib/workforce-own-incentives';
import {reconcileOwnProduction,type OwnProductionDay} from '@/lib/own-production-breakdown';
import {ConnectProductionBreakdown} from './connect-production-breakdown';
import {ConnectDailyPaymentBreakdown,type DailyPaymentProvider} from './connect-daily-payment-breakdown';
import paymentStyles from './connect-workforce-payments.module.css';

type PaymentData = {
  period: string;
  mapping: Array<{ id: string; providerMemberId: string | null; provider: string | null; paymentMethod: string | null; effectiveFrom: string | null; effectiveTo: string | null }>;
  summary: { deliveries: number; earnings: number; workingDays: number; latestDate: string | null; rateLines: Array<{ code: string; label: string; count: number; rate: number; amount: number; sharedRate?: boolean }> };
  daily: Array<{ date: string; deliveries: number; amazonDeliveries: number; swaDeliveries: number; cReturns: number; mfn: number; mfnReturns: number; earnings: number; rateLines: Array<{ code: string; label: string; count: number; rate: number; amount: number }>; providers: DailyPaymentProvider[] }>;
  statements: Array<{ id: string; runNumber: string; periodStart: string; periodEnd: string; status: string; statusLabel: string; paymentDate: string | null; paymentReference: string | null; shipments: number; workingDays: number; baseAmount: number; incentiveAmount: number; adjustmentAmount: number; deductionAmount: number; grossAmount: number; netAmount: number }>;
  rateCard: Array<{ code: string; rate: number; providerMemberId: string | null; effectiveFrom: string | null; effectiveTo: string | null }>;
};

type EarningsData = {
  summary: { grossAmount: number; netAmount:number; baseAmount:number; incentiveAmount:number; additions:number; deductionAmount:number };
  incentives:OwnIncentiveSummary;
  adjustments:OwnAdjustmentLedger;
  earnings: Array<{ daily: OwnProductionDay[] }>;
};

type Tab = "earnings" | "statements" | "advances" | "rate-card";
const date = (value: string | null) => value ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00`)) : "—";
const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());

export function ConnectWorkforcePayments({ account }: { account: AppAccount }) {
  return <WorkforcePayments key={`${account.companyId}:${account.profileType}:${account.id}:${account.pageAccess?.join(',')}`} account={account} />;
}

function WorkforcePayments({ account }: { account: AppAccount }) {
  const access = account.pageAccess ?? [];
  const earningsAllowed = access.includes("earnings");
  const advancesAllowed = access.includes("advances");
  const rateCardAllowed = access.includes("rate_card");
  const firstTab: Tab = earningsAllowed ? "earnings" : advancesAllowed ? "advances" : "rate-card";
  const [tab, setTab] = useState<Tab>(firstTab);
  const [data, setData] = useState<PaymentData | null>(null);
  const [error, setError] = useState("");
  const [estimateError, setEstimateError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedDate, setExpandedDate] = useState("");
  const [calculated,setCalculated]=useState<EarningsData|null>(null);
  const generation=useRef(0);
  const load = useCallback(async () => {
    const version=++generation.current;
    setLoading(true); setError("");setEstimateError('');setData(null);setCalculated(null);setExpandedDate('');
    if(!earningsAllowed&&!rateCardAllowed){setLoading(false);return;}
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const [details, estimate] = await Promise.all([
        paymentSectionResult(async()=>{
          const response=await fetch(`/api/connect/workforce-payments?${query}`,{cache:'no-store'});
          const payload=await response.json();
          if(!response.ok)throw new Error(payload.error||'Unable to load payment statements and rate details.');
          if(!payload.summary||!Array.isArray(payload.mapping)||!Array.isArray(payload.daily)||!Array.isArray(payload.statements)||!Array.isArray(payload.rateCard))throw new Error('Payment details could not be verified. Please retry.');
          return payload as PaymentData;
        },'Unable to load payment details.'),
        paymentSectionResult(async()=>{
          if(!earningsAllowed)return null;
          const response=await fetch(`/api/connect/earnings?${query}`,{cache:'no-store'});
          const payload=await response.json();
          if(!response.ok)throw new Error(payload.error||'Unable to reconcile your payment estimate. Please retry.');
          const result=payload as EarningsData;
          if(!result.adjustments||!result.incentives||!Array.isArray(result.incentives.campaigns)||!Number.isFinite(result.summary?.incentiveAmount)||!Number.isFinite(result.summary?.netAmount)||!Array.isArray(result.earnings)||result.earnings.some(m=>!Array.isArray(m.daily)||m.daily.some(r=>!Number.isFinite(r.amount))))throw new Error('Your payment estimate could not be reconciled. Please retry.');
          reconcileOwnProduction(result.earnings,result.summary);
          return result;
        },'Unable to reconcile your payment estimate. Please retry.')
      ]);
      if(version!==generation.current)return;
      setError(details.error);setEstimateError(estimate.error);
      const payload=details.data,calculated=estimate.data;
      const earningsByDate = new Map<string, number>();
      for (const mapping of calculated?.earnings ?? []) for (const row of mapping.daily) {
        earningsByDate.set(row.date, (earningsByDate.get(row.date) ?? 0) + Number(row.amount ?? 0));
      }
      if(version!==generation.current)return;
      setCalculated(calculated);
      setData(payload?{
        ...payload,
        summary: { ...payload.summary, earnings: calculated?.summary.netAmount ?? payload.summary.earnings },
        daily: payload.daily.map((row: PaymentData["daily"][number]) => ({ ...row, earnings: calculated?(earningsByDate.get(row.date)??0):row.earnings }))
      }:null);
    } catch (reason) {
      if(version===generation.current)setError(reason instanceof Error ? reason.message : "Unable to load earnings.");
    } finally { if(version===generation.current)setLoading(false); }
  }, [account.id, account.profileType,earningsAllowed,rateCardAllowed]);
  useEffect(() => { void load();return()=>{generation.current++;}; }, [load]);
  useEffect(() => { if (((tab === "earnings"||tab==='statements') && !earningsAllowed) || (tab === "advances" && !advancesAllowed) || (tab === "rate-card" && !rateCardAllowed)) setTab(firstTab); }, [advancesAllowed, earningsAllowed, firstTab, rateCardAllowed, tab]);
  const mapping = data?.mapping[0];
  const visibleError=error||(tab==='earnings'?estimateError:'');
  const hasMap = Boolean(data?.mapping.length);
  const entries = useMemo(() => data?.rateCard ?? [], [data]);
  const productionDays=calculated?.earnings.flatMap(earning=>earning.daily)??[];
  const dailyProduction=calculated?reconcileOwnProduction(calculated.earnings,calculated.summary):[];
  const paymentDayByDate = useMemo(() => new Map((data?.daily ?? []).map((day) => [day.date, day])), [data]);
  const statementLabel = (start: string, end: string) => `${new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" }).format(new Date(`${start}T00:00:00`))} · ${date(start)} – ${date(end)}`;
  const downloadStatement = (statementId: string) => {
    const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType, statementId });
    window.open(`/api/connect/workforce-payment-statement?${query}`, "_blank", "noopener,noreferrer");
  };

  return <section className={`dx-workforce-payments ${paymentStyles.page}`}>
    <header className="dx-page-intro">
      <small>My pay</small><h1>Payments</h1><p>Earnings, statements, advances and rates.</p>
    </header>
    <nav aria-label="Payment section" className="dx-workforce-tabs">
      {earningsAllowed ? <button className={tab === "earnings" ? "active" : ""} onClick={() => setTab("earnings")}><IndianRupee />Live earnings</button> : null}
      {earningsAllowed ? <button className={tab === "statements" ? "active" : ""} onClick={() => setTab("statements")}><ReceiptText />Statements</button> : null}
      {advancesAllowed ? <button className={tab === "advances" ? "active" : ""} onClick={() => setTab("advances")}><WalletCards />Advances</button> : null}
      {rateCardAllowed ? <button className={tab === "rate-card" ? "active" : ""} onClick={() => setTab("rate-card")}><ReceiptText />Rate card</button> : null}
    </nav>
    {tab === "earnings" && earningsAllowed ? <ConnectWorkforceJoining key={`${account.profileType}:${account.id}`} account={account} /> : null}
    {tab === "advances" && advancesAllowed ? <ConnectAdvances account={account} /> : null}
    {tab !== "advances" && loading ? <div className="dx-loader"><span /><small>Loading your payment details…</small></div> : null}
    {tab !== "advances" && visibleError ? <div role="alert" className="dx-alert error">{visibleError}{tab==='earnings'&&estimateError&&!error?<p>Your confirmed payment statements and rate card remain available in their tabs.</p>:null}<button onClick={() => void load()}><RefreshCw />Retry</button></div> : null}
    {tab === "earnings" && earningsAllowed && data && calculated && !loading && !visibleError ? <>
      {!hasMap ? <section className="dx-workforce-empty"><i><Route /></i><div><strong>Payment mapping is being set up</strong><p>Your profile is active, but it is not yet connected to a provider ID and rate card. Your station team can complete the mapping before live earnings appear here.</p></div></section> : <>
        <section className="dx-workforce-payment-hero"><span><small>{data.period}</small><strong>{money(data.summary.earnings)}</strong><em>Estimated live earnings</em></span>{rateCardAllowed?<button onClick={() => setTab("rate-card")}>View rate card <ChevronRight /></button>:null}</section>
        {calculated?<p className="dx-workforce-payment-note">Production {money(calculated.summary.baseAmount)} · Incentives {money(calculated.summary.incentiveAmount)} · Adjustments {money(calculated.summary.additions-calculated.summary.deductionAmount)}</p>:null}
        <section className="dx-workforce-payment-stats"><article><Route /><span><strong>{dailyProduction.reduce((sum,day)=>sum+day.deliveries,0).toLocaleString('en-IN')}</strong><small>Deliveries</small></span></article><article><CalendarDays /><span><strong>{dailyProduction.length}</strong><small>Active days</small></span></article><article><IndianRupee /><span><strong>{date(dailyProduction[0]?.date??null)}</strong><small>Latest import</small></span></article></section>
        {calculated?<ConnectPayAdjustments ledger={calculated.adjustments}/>:null}
        <ConnectPayIncentives incentives={calculated.incentives}/>
        <section className="dx-workforce-mtd-breakdown"><header><h2>Earnings breakdown</h2></header><ConnectProductionBreakdown days={productionDays}/></section>
<section className={`dx-workforce-ledger ${paymentStyles.ledger}`}><header><h2>Daily earnings</h2><button onClick={() => void load()} aria-label="Refresh earnings"><RefreshCw /></button></header>{dailyProduction.length ? <div>{dailyProduction.map(row=>{const detail=paymentDayByDate.get(row.date);return <article className={expandedDate===row.date?'expanded':''} key={row.date}><button aria-expanded={expandedDate===row.date} className="dx-workforce-day" onClick={()=>setExpandedDate(current=>current===row.date?'':row.date)} type="button"><span><strong>{date(row.date)}</strong><small>{row.deliveries.toLocaleString('en-IN')} deliveries</small></span><b>{money(row.amount)}<ChevronDown/></b></button>{expandedDate===row.date?(detail?.providers.length?<ConnectDailyPaymentBreakdown associateName={account.name??account.reference??"Associate"} providers={detail.providers}/>:<ConnectProductionBreakdown days={productionDays.filter(day=>day.date===row.date)}/>):null}</article>})}</div>:<div className="dx-empty"><ReceiptText/><strong>No delivery data yet</strong></div>}</section>
      </>}
      {calculated&&!hasMap?<ConnectPayAdjustments ledger={calculated.adjustments}/>:null}
    </> : null}
    {tab === "statements" && earningsAllowed && data && !loading && !error ? <section className="dx-workforce-statements"><header><h2>Statements</h2></header>{data.statements.length ? <div>{data.statements.map((statement) => <article key={statement.id}><div><span><strong>{statementLabel(statement.periodStart, statement.periodEnd)}</strong><em className={statement.status}>{statement.statusLabel}</em></span><small>{statement.shipments.toLocaleString("en-IN")} shipments · {statement.workingDays} active days{statement.paymentReference ? ` · Ref ${statement.paymentReference}` : ""}</small><dl><div><dt>Base</dt><dd>{money(statement.baseAmount)}</dd></div><div><dt>Incentives</dt><dd>{money(statement.incentiveAmount)}</dd></div><div><dt>Adjustments</dt><dd>{money(statement.adjustmentAmount)}</dd></div><div><dt>Deductions</dt><dd>-{money(statement.deductionAmount)}</dd></div></dl></div><aside><strong>{money(statement.netAmount)}</strong><small>{statement.paymentDate ? `Paid ${date(statement.paymentDate)}` : "Awaiting disbursal"}</small><button onClick={() => downloadStatement(statement.id)} type="button"><Download />Open statement</button></aside></article>)}</div> : <div className="dx-empty"><ReceiptText /><strong>No statements yet</strong></div>}</section> : null}
    {tab === "rate-card" && rateCardAllowed && data && !loading && !error ? <>
      <p className="dx-workforce-payment-note">Reference rates for your active provider mapping.</p>
      {!hasMap ? <section className="dx-workforce-empty"><i><ReceiptText /></i><div><strong>No active rate card yet</strong><p>Once your provider ID is mapped, the applicable station rate card will appear here.</p></div></section> : <section className="dx-workforce-rate-card"><header><small>Active mapping</small><h2>{mapping?.paymentMethod || "Rate card"}</h2><p>{mapping?.provider ? `${mapping.provider} · ` : ""}Provider ID {mapping?.providerMemberId || "—"}</p></header><div className="dx-workforce-rate-meta"><span>Effective from <b>{date(mapping?.effectiveFrom ?? null)}</b></span><span>Valid to <b>{date(mapping?.effectiveTo ?? null)}</b></span></div>{entries.length ? <div className="dx-workforce-rate-lines">{entries.map((entry, index) => <article key={`${entry.code}:${index}`}><span><strong>{label(entry.code)}</strong><small>{entry.providerMemberId ? `Provider ID ${entry.providerMemberId}` : "Active mapping"}</small></span><b>{money(entry.rate)}</b></article>)}</div> : <div className="dx-empty"><ReceiptText /><strong>Rate details are not published yet</strong><small>Your payment mapping is active. The station can publish rate details when they are ready.</small></div>}</section>}
    </> : null}
  </section>;
}

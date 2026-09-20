"use client";

import { CalendarDays, ChevronDown, ChevronRight, Download, IndianRupee, ReceiptText, RefreshCw, Route, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppAccount } from "./connect-profile-app";
import { ConnectAdvances } from "./connect-advances";

type PaymentData = {
  period: string;
  mapping: Array<{ id: string; providerMemberId: string | null; provider: string | null; paymentMethod: string | null; effectiveFrom: string | null; effectiveTo: string | null }>;
  summary: { deliveries: number; earnings: number; workingDays: number; latestDate: string | null; rateLines: Array<{ code: string; label: string; count: number; rate: number; amount: number; sharedRate?: boolean }> };
  daily: Array<{ date: string; deliveries: number; amazonDeliveries: number; swaDeliveries: number; cReturns: number; mfn: number; mfnReturns: number; earnings: number; rateLines: Array<{ code: string; label: string; count: number; rate: number; amount: number; sharedRate?: boolean }> }>;
  statements: Array<{ id: string; runNumber: string; periodStart: string; periodEnd: string; status: string; paymentDate: string | null; paymentReference: string | null; shipments: number; workingDays: number; baseAmount: number; incentiveAmount: number; adjustmentAmount: number; deductionAmount: number; grossAmount: number; netAmount: number }>;
  rateCard: Array<{ code: string; rate: number; providerMemberId: string | null; effectiveFrom: string | null; effectiveTo: string | null }>;
};

type EarningsData = {
  summary: { grossAmount: number };
  earnings: Array<{ daily: Array<{ date: string; amount: number }> }>;
};

type Tab = "earnings" | "statements" | "advances" | "rate-card";
const date = (value: string | null) => value ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00`)) : "—";
const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());

export function ConnectWorkforcePayments({ account }: { account: AppAccount }) {
  const access = account.pageAccess ?? [];
  const earningsAllowed = access.includes("earnings");
  const advancesAllowed = access.includes("advances");
  const rateCardAllowed = access.includes("rate_card");
  const firstTab: Tab = earningsAllowed ? "earnings" : advancesAllowed ? "advances" : "rate-card";
  const [tab, setTab] = useState<Tab>(firstTab);
  const [data, setData] = useState<PaymentData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedDate, setExpandedDate] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const [response, earningsResponse] = await Promise.all([
        fetch(`/api/connect/workforce-payments?${query}`, { cache: "no-store" }),
        fetch(`/api/connect/earnings?${query}`, { cache: "no-store" })
      ]);
      const [payload, earningsPayload] = await Promise.all([response.json(), earningsResponse.json()]);
      if (!response.ok) throw new Error(payload.error || "Unable to load earnings.");
      const calculated = earningsResponse.ok ? earningsPayload as EarningsData : null;
      const earningsByDate = new Map<string, number>();
      for (const mapping of calculated?.earnings ?? []) for (const row of mapping.daily) {
        earningsByDate.set(row.date, (earningsByDate.get(row.date) ?? 0) + Number(row.amount ?? 0));
      }
      setData({
        ...payload,
        summary: { ...payload.summary, earnings: calculated?.summary.grossAmount ?? payload.summary.earnings },
        daily: payload.daily.map((row: PaymentData["daily"][number]) => ({ ...row, earnings: earningsByDate.get(row.date) ?? row.earnings }))
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load earnings.");
    } finally { setLoading(false); }
  }, [account.id, account.profileType]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if ((tab === "earnings" && !earningsAllowed) || (tab === "advances" && !advancesAllowed) || (tab === "rate-card" && !rateCardAllowed)) setTab(firstTab); }, [advancesAllowed, earningsAllowed, firstTab, rateCardAllowed, tab]);
  const mapping = data?.mapping[0];
  const hasMap = Boolean(data?.mapping.length);
  const entries = useMemo(() => data?.rateCard ?? [], [data]);
  const statementLabel = (start: string, end: string) => `${new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" }).format(new Date(`${start}T00:00:00`))} · ${date(start)} – ${date(end)}`;
  const downloadStatement = (statementId: string) => {
    const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType, statementId });
    window.open(`/api/connect/workforce-payment-statement?${query}`, "_blank", "noopener,noreferrer");
  };

  return <section className="dx-workforce-payments">
    <header className="dx-page-intro">
      <small>My pay</small><h1>Payments</h1><p>See live earnings, payment advances and your active rate card in one place.</p>
    </header>
    <nav aria-label="Payment section" className="dx-workforce-tabs">
      {earningsAllowed ? <button className={tab === "earnings" ? "active" : ""} onClick={() => setTab("earnings")}><IndianRupee />Live earnings</button> : null}
      {earningsAllowed ? <button className={tab === "statements" ? "active" : ""} onClick={() => setTab("statements")}><ReceiptText />Monthly statements</button> : null}
      {advancesAllowed ? <button className={tab === "advances" ? "active" : ""} onClick={() => setTab("advances")}><WalletCards />Advances</button> : null}
      {rateCardAllowed ? <button className={tab === "rate-card" ? "active" : ""} onClick={() => setTab("rate-card")}><ReceiptText />Rate card</button> : null}
    </nav>
    {tab === "advances" && advancesAllowed ? <ConnectAdvances account={account} /> : null}
    {tab !== "advances" && loading ? <div className="dx-loader"><span /><small>Loading your payment details…</small></div> : null}
    {tab !== "advances" && error ? <div className="dx-alert error">{error}<button onClick={() => void load()}><RefreshCw />Retry</button></div> : null}
    {tab === "earnings" && earningsAllowed && data && !loading && !error ? <>
      {!hasMap ? <section className="dx-workforce-empty"><i><Route /></i><div><strong>Payment mapping is being set up</strong><p>Your profile is active, but it is not yet connected to a provider ID and rate card. Your station team can complete the mapping before live earnings appear here.</p></div></section> : <>
        <section className="dx-workforce-payment-hero"><span><small>{data.period}</small><strong>{money(data.summary.earnings)}</strong><em>Estimated live earnings</em></span><button onClick={() => setTab("rate-card")}>View rate card <ChevronRight /></button></section>
        <section className="dx-workforce-payment-stats"><article><Route /><span><strong>{data.summary.deliveries.toLocaleString("en-IN")}</strong><small>Deliveries</small></span></article><article><CalendarDays /><span><strong>{data.summary.workingDays}</strong><small>Active days</small></span></article><article><IndianRupee /><span><strong>{date(data.summary.latestDate)}</strong><small>Latest import</small></span></article></section>
        <section className="dx-workforce-mtd-breakdown"><header><div><small>Month to date</small><h2>Activity &amp; earnings break-up</h2><p>Your deliveries and the payment estimate for each activity this month.</p></div></header>{data.summary.rateLines.length ? <div>{data.summary.rateLines.map((line) => <article key={`${line.code}:${line.rate}`}><span><strong>{line.label}</strong><small>{line.sharedRate ? "Included at the delivery rate" : "Payment rate"}</small></span><b>{line.count.toLocaleString("en-IN")} × {money(line.rate)}<em>{money(line.amount)}</em></b></article>)}</div> : <div className="dx-empty"><ReceiptText /><strong>Activity details are not available yet</strong><small>Your payment estimate will update when the next shipment import is processed.</small></div>}</section>
        <section className="dx-workforce-ledger"><header><div><small>Daily view</small><h2>This month&apos;s earnings</h2></div><button onClick={() => void load()} aria-label="Refresh earnings"><RefreshCw /></button></header>{data.daily.length ? <div>{data.daily.map((row) => <article className={expandedDate === row.date ? "expanded" : ""} key={row.date}><button aria-expanded={expandedDate === row.date} className="dx-workforce-day" onClick={() => setExpandedDate((current) => current === row.date ? "" : row.date)} type="button"><span><strong>{date(row.date)}</strong><small>{row.deliveries.toLocaleString("en-IN")} total deliveries · tap for break-up</small></span><b>{money(row.earnings)}<ChevronDown /></b></button>{expandedDate === row.date ? <div className="dx-workforce-rate-breakdown">{row.rateLines.length ? row.rateLines.map((line) => <div key={`${line.code}:${line.rate}`}><span><strong>{line.label}</strong><small>{line.sharedRate ? "Included at the delivery rate" : "Payment rate"}</small></span><b>{line.count.toLocaleString("en-IN")} × {money(line.rate)}<em>{money(line.amount)}</em></b></div>) : <small>Activity details will appear after the next shipment import.</small>}</div> : null}</article>)}</div> : <div className="dx-empty"><ReceiptText /><strong>No imported delivery data yet</strong><small>New Amazon delivery imports will show here after they are mapped and processed.</small></div>}</section>
        <p className="dx-workforce-payment-note">Live earnings use imported delivery data and your active rate card. Final payout remains subject to the payout review cycle.</p>
      </>}
    </> : null}
    {tab === "statements" && earningsAllowed && data && !loading && !error ? <section className="dx-workforce-statements"><header><div><small>Payment history</small><h2>Monthly payment statements</h2><p>Approved and paid cycles are retained here. Open one to save a PDF invoice.</p></div></header>{data.statements.length ? <div>{data.statements.map((statement) => <article key={statement.id}><div><span><strong>{statementLabel(statement.periodStart, statement.periodEnd)}</strong><em className={statement.status}>{statement.status === "paid" ? "Paid" : "Approved"}</em></span><small>{statement.shipments.toLocaleString("en-IN")} shipments · {statement.workingDays} active days{statement.paymentReference ? ` · Ref ${statement.paymentReference}` : ""}</small><dl><div><dt>Base</dt><dd>{money(statement.baseAmount)}</dd></div><div><dt>Incentives</dt><dd>{money(statement.incentiveAmount)}</dd></div><div><dt>Adjustments</dt><dd>{money(statement.adjustmentAmount)}</dd></div><div><dt>Deductions</dt><dd>-{money(statement.deductionAmount)}</dd></div></dl></div><aside><strong>{money(statement.netAmount)}</strong><small>{statement.paymentDate ? `Paid ${date(statement.paymentDate)}` : "Awaiting disbursal"}</small><button onClick={() => downloadStatement(statement.id)} type="button"><Download />Invoice PDF</button></aside></article>)}</div> : <div className="dx-empty"><ReceiptText /><strong>No payment statements yet</strong><small>Once a payment cycle is approved, its invoice and payment break-up will be available here.</small></div>}</section> : null}
    {tab === "rate-card" && rateCardAllowed && data && !loading && !error ? <>
      {!hasMap ? <section className="dx-workforce-empty"><i><ReceiptText /></i><div><strong>No active rate card yet</strong><p>Once your provider ID is mapped, the applicable station rate card will appear here.</p></div></section> : <section className="dx-workforce-rate-card"><header><small>Active mapping</small><h2>{mapping?.paymentMethod || "Rate card"}</h2><p>{mapping?.provider ? `${mapping.provider} · ` : ""}Provider ID {mapping?.providerMemberId || "—"}</p></header><div className="dx-workforce-rate-meta"><span>Effective from <b>{date(mapping?.effectiveFrom ?? null)}</b></span><span>Valid to <b>{date(mapping?.effectiveTo ?? null)}</b></span></div>{entries.length ? <div className="dx-workforce-rate-lines">{entries.map((entry, index) => <article key={`${entry.code}:${index}`}><span><strong>{label(entry.code)}</strong><small>{entry.providerMemberId ? `Provider ID ${entry.providerMemberId}` : "Active mapping"}</small></span><b>{money(entry.rate)}</b></article>)}</div> : <div className="dx-empty"><ReceiptText /><strong>Rate details are not published yet</strong><small>Your payment mapping is active. The station can publish rate details when they are ready.</small></div>}</section>}
    </> : null}
  </section>;
}

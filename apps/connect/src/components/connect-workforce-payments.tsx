"use client";

import { CalendarDays, ChevronRight, IndianRupee, ReceiptText, RefreshCw, Route, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppAccount } from "./connect-profile-app";
import { ConnectAdvances } from "./connect-advances";

type PaymentData = {
  period: string;
  mapping: Array<{ id: string; providerMemberId: string | null; provider: string | null; paymentMethod: string | null; effectiveFrom: string | null; effectiveTo: string | null }>;
  summary: { deliveries: number; earnings: number; workingDays: number; latestDate: string | null };
  daily: Array<{ date: string; deliveries: number; earnings: number }>;
  rateCard: Array<{ code: string; rate: number; providerMemberId: string | null; effectiveFrom: string | null; effectiveTo: string | null }>;
};

type Tab = "earnings" | "advances" | "rate-card";
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
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/workforce-payments?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load earnings.");
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load earnings.");
    } finally { setLoading(false); }
  }, [account.id, account.profileType]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if ((tab === "earnings" && !earningsAllowed) || (tab === "advances" && !advancesAllowed) || (tab === "rate-card" && !rateCardAllowed)) setTab(firstTab); }, [advancesAllowed, earningsAllowed, firstTab, rateCardAllowed, tab]);
  const mapping = data?.mapping[0];
  const hasMap = Boolean(data?.mapping.length);
  const entries = useMemo(() => data?.rateCard ?? [], [data]);

  return <section className="dx-workforce-payments">
    <header className="dx-page-intro">
      <small>My pay</small><h1>Earnings & payments</h1><p>See imported delivery earnings, your active rate card and advance requests in one place.</p>
    </header>
    <nav aria-label="Payment section" className="dx-workforce-tabs">
      {earningsAllowed ? <button className={tab === "earnings" ? "active" : ""} onClick={() => setTab("earnings")}><IndianRupee />Live earnings</button> : null}
      {advancesAllowed ? <button className={tab === "advances" ? "active" : ""} onClick={() => setTab("advances")}><WalletCards />Advances</button> : null}
      {rateCardAllowed ? <button className={tab === "rate-card" ? "active" : ""} onClick={() => setTab("rate-card")}><ReceiptText />Rate card</button> : null}
    </nav>
    {tab === "advances" && advancesAllowed ? <ConnectAdvances account={account} /> : null}
    {tab !== "advances" && loading ? <div className="dx-loader"><span /><small>Loading your payment details…</small></div> : null}
    {tab !== "advances" && error ? <div className="dx-alert error">{error}<button onClick={() => void load()}><RefreshCw />Retry</button></div> : null}
    {tab === "earnings" && earningsAllowed && data && !loading && !error ? <>
      {!hasMap ? <section className="dx-workforce-empty"><i><Route /></i><div><strong>Payment mapping is being set up</strong><p>Your profile is active, but it is not yet connected to a provider ID and rate card. Your station team can complete the mapping before live earnings appear here.</p></div></section> : <>
        <section className="dx-workforce-payment-hero"><span><small>{data.period}</small><strong>{money(data.summary.earnings)}</strong><em>Recorded earnings</em></span><button onClick={() => setTab("rate-card")}>View rate card <ChevronRight /></button></section>
        <section className="dx-workforce-payment-stats"><article><Route /><span><strong>{data.summary.deliveries.toLocaleString("en-IN")}</strong><small>Deliveries</small></span></article><article><CalendarDays /><span><strong>{data.summary.workingDays}</strong><small>Active days</small></span></article><article><IndianRupee /><span><strong>{date(data.summary.latestDate)}</strong><small>Latest import</small></span></article></section>
        <section className="dx-workforce-ledger"><header><div><small>Daily view</small><h2>This month&apos;s earnings</h2></div><button onClick={() => void load()} aria-label="Refresh earnings"><RefreshCw /></button></header>{data.daily.length ? <div>{data.daily.map((row) => <article key={row.date}><span><strong>{date(row.date)}</strong><small>{row.deliveries.toLocaleString("en-IN")} deliveries</small></span><b>{money(row.earnings)}</b></article>)}</div> : <div className="dx-empty"><ReceiptText /><strong>No imported delivery data yet</strong><small>New Amazon delivery imports will show here after they are mapped and processed.</small></div>}</section>
        <p className="dx-workforce-payment-note">Recorded earnings reflect processed delivery data and remain subject to the payout review cycle.</p>
      </>}
    </> : null}
    {tab === "rate-card" && rateCardAllowed && data && !loading && !error ? <>
      {!hasMap ? <section className="dx-workforce-empty"><i><ReceiptText /></i><div><strong>No active rate card yet</strong><p>Once your provider ID is mapped, the applicable station rate card will appear here.</p></div></section> : <section className="dx-workforce-rate-card"><header><small>Active mapping</small><h2>{mapping?.paymentMethod || "Rate card"}</h2><p>{mapping?.provider ? `${mapping.provider} · ` : ""}Provider ID {mapping?.providerMemberId || "—"}</p></header><div className="dx-workforce-rate-meta"><span>Effective from <b>{date(mapping?.effectiveFrom ?? null)}</b></span><span>Valid to <b>{date(mapping?.effectiveTo ?? null)}</b></span></div>{entries.length ? <div className="dx-workforce-rate-lines">{entries.map((entry, index) => <article key={`${entry.code}:${index}`}><span><strong>{label(entry.code)}</strong><small>{entry.providerMemberId ? `Provider ID ${entry.providerMemberId}` : "Active mapping"}</small></span><b>{money(entry.rate)}</b></article>)}</div> : <div className="dx-empty"><ReceiptText /><strong>Rate details are not published yet</strong><small>Your payment mapping is active. The station can publish rate details when they are ready.</small></div>}</section>}
    </> : null}
  </section>;
}

"use client";

import { ArrowLeftRight, CalendarDays, Check, Clock3, RefreshCw, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppAccount } from "./connect-profile-app";

type Shift = { id: string; name: string; code: string; start_time: string; end_time: string };
type Partner = { id: string; workerType: string; workerId: string; name?: string; code?: string; dayType: "working" | "weekly_off"; shift: Shift | null };
type RosterDay = { id: string; date: string; dayType: "working" | "weekly_off"; locationId: string | null; shift: Shift | null; canSwap: boolean; partners: Partner[] };
type SwapRequest = {
  id: string;
  date: string;
  status: "pending_partner" | "pending_manager" | "approved" | "rejected" | "cancelled" | "expired";
  note?: string | null;
  requestedAt: string;
  isRequester: boolean;
  isPartner: boolean;
  counterpart: { name: string; code: string };
  requesterShift: Shift | null;
  partnerShift: Shift | null;
  requesterDayType: "working" | "weekly_off";
  partnerDayType: "working" | "weekly_off";
};
type RosterPayload = { days: RosterDay[]; requests: SwapRequest[]; leadHours: number };

function displayDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "2-digit", month: "short" }).format(new Date(`${value}T00:00:00`));
}
function shortTime(value?: string | null) { return value ? value.slice(0, 5) : ""; }
function shiftLabel(shift: Shift | null, dayType: string) {
  return dayType === "weekly_off" ? "Weekly off" : shift ? `${shortTime(shift.start_time)}–${shortTime(shift.end_time)}` : "Shift not assigned";
}
const statusLabel: Record<SwapRequest["status"], string> = {
  pending_partner: "Awaiting colleague",
  pending_manager: "Awaiting manager",
  approved: "Swap approved",
  rejected: "Declined",
  cancelled: "Cancelled",
  expired: "Expired"
};

export function ConnectRoster({ account }: { account: AppAccount }) {
  const [data, setData] = useState<RosterPayload | null>(null);
  const [selectedDay, setSelectedDay] = useState<RosterDay | null>(null);
  const [partnerEntryId, setPartnerEntryId] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/roster?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load your roster.");
      setData(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load your roster."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType]);

  useEffect(() => { void load(); }, [load]);
  const selectedPartner = useMemo(() => selectedDay?.partners.find((partner) => partner.id === partnerEntryId) ?? null, [selectedDay, partnerEntryId]);

  async function requestSwap() {
    if (!selectedDay || !partnerEntryId) return;
    setPending("request"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/roster", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, profileType: account.profileType, requesterEntryId: selectedDay.id, partnerEntryId, note }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to request the swap.");
      setNotice(payload.notice); setSelectedDay(null); setPartnerEntryId(""); setNote(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to request the swap."); }
    finally { setPending(""); }
  }

  async function decide(requestId: string, action: "accept" | "reject" | "cancel") {
    setPending(`${requestId}:${action}`); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/roster", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, profileType: account.profileType, requestId, action }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update the swap.");
      setNotice(payload.notice); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update the swap."); }
    finally { setPending(""); }
  }

  return <section className="dx-roster">
    <header className="dx-page-intro"><small>My work plan</small><h1>Roster</h1><p>Your next seven days, shift changes and approvals.</p></header>
    {error ? <div className="dx-alert error"><span>{error}</span><button onClick={() => void load()}><RefreshCw /></button></div> : null}
    {notice ? <div className="dx-alert success"><span>{notice}</span><button onClick={() => setNotice("")}><X /></button></div> : null}
    {loading ? <div className="dx-loader"><span /><small>Loading roster…</small></div> : null}
    {!loading ? <div className="dx-roster-week">
      {(data?.days ?? []).length ? data?.days.map((day) => <article className={day.dayType === "weekly_off" ? "off" : ""} key={day.id}>
        <div className="dx-roster-date"><CalendarDays /><span><strong>{displayDate(day.date)}</strong><small>{day.dayType === "weekly_off" ? "Rest day" : day.shift?.name || "Working day"}</small></span></div>
        <div className="dx-roster-shift"><Clock3 /><strong>{shiftLabel(day.shift, day.dayType)}</strong></div>
        <button disabled={!day.canSwap || !day.partners.length} onClick={() => { setSelectedDay(day); setPartnerEntryId(""); setNote(""); }}><ArrowLeftRight />{day.canSwap ? day.partners.length ? "Request swap" : "No partner available" : `Closed ${data?.leadHours ?? 24}h before`}</button>
      </article>) : <div className="dx-roster-empty"><CalendarDays /><strong>No approved roster yet</strong><small>Your published shifts will appear here.</small></div>}
    </div> : null}

    {selectedDay ? <div className="dx-roster-swap-card">
      <header><span><small>Swap {displayDate(selectedDay.date)}</small><strong>{shiftLabel(selectedDay.shift, selectedDay.dayType)}</strong></span><button aria-label="Close swap request" onClick={() => setSelectedDay(null)}><X /></button></header>
      <label>Swap with<select onChange={(event) => setPartnerEntryId(event.target.value)} value={partnerEntryId}><option value="">Choose colleague and shift</option>{selectedDay.partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name || partner.code || "Colleague"} · {shiftLabel(partner.shift, partner.dayType)}</option>)}</select></label>
      {selectedPartner ? <div className="dx-roster-exchange"><span><UserRound /><small>You receive</small><strong>{shiftLabel(selectedPartner.shift, selectedPartner.dayType)}</strong></span><ArrowLeftRight /><span><UserRound /><small>{selectedPartner.name} receives</small><strong>{shiftLabel(selectedDay.shift, selectedDay.dayType)}</strong></span></div> : null}
      <label>Note <span>(optional)</span><textarea maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Add useful context" rows={2} value={note} /></label>
      <button className="dx-roster-primary" disabled={!partnerEntryId || pending === "request"} onClick={() => void requestSwap()}>{pending === "request" ? "Sending…" : "Send swap request"}</button>
      <small className="dx-roster-rule">Both colleagues must agree. Your immediate manager gives final approval.</small>
    </div> : null}

    {!loading && (data?.requests ?? []).length ? <section className="dx-roster-requests"><header><small>Shift changes</small><h2>Swap requests</h2></header>{data?.requests.map((request) => <article key={request.id}>
      <div><i><ArrowLeftRight /></i><span><strong>{displayDate(request.date)} · {request.counterpart.name}</strong><small>{shiftLabel(request.requesterShift, request.requesterDayType)} ↔ {shiftLabel(request.partnerShift, request.partnerDayType)}</small></span><em className={request.status}>{statusLabel[request.status]}</em></div>
      {request.status === "pending_partner" && request.isPartner ? <footer><button className="reject" disabled={Boolean(pending)} onClick={() => void decide(request.id, "reject")}><X />Decline</button><button className="accept" disabled={Boolean(pending)} onClick={() => void decide(request.id, "accept")}><Check />Accept</button></footer> : null}
      {request.isRequester && ["pending_partner", "pending_manager"].includes(request.status) ? <footer><button className="cancel" disabled={Boolean(pending)} onClick={() => void decide(request.id, "cancel")}><X />Cancel request</button></footer> : null}
    </article>)}</section> : null}
  </section>;
}

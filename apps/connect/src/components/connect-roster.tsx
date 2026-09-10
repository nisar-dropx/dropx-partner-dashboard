"use client";

import { ArrowLeftRight, CalendarDays, Check, Clock3, RefreshCw, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatShiftClock } from "@/lib/roster-plan-preference";
import { rosterChangeDeadlineShortLabel } from "@/lib/roster-change-deadline";
import type { AppAccount } from "./connect-profile-app";

type Shift = { id: string; name: string; code: string; start_time: string; end_time: string };
type Partner = { id: string; workerType: string; workerId: string; name?: string; code?: string; dayType: "working" | "weekly_off"; shift: Shift | null };
type RosterDay = { id: string; date: string; dayType: "working" | "weekly_off"; locationId: string | null; shift: Shift | null; isProjected: boolean; canSwap: boolean; partners: Partner[] };
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
type RosterPayload = { days: RosterDay[]; requests: SwapRequest[]; leadHours: number; viewDays?: number };

function displayDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "2-digit", month: "short" }).format(new Date(`${value}T00:00:00`));
}

function weekdayLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(new Date(`${value}T00:00:00`));
}

function dayNumber(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit" }).format(new Date(`${value}T00:00:00`));
}

function monthLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date(`${value}T00:00:00`));
}

function shortTime(value?: string | null) {
  const clock = formatShiftClock(value);
  return clock === "--:--" ? "" : clock;
}

function shiftLabel(shift: Shift | null, dayType: string) {
  return dayType === "weekly_off" ? "Weekly off" : shift ? `${shortTime(shift.start_time)}–${shortTime(shift.end_time)}` : "Shift not assigned";
}

function localIsoDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function weekKey(value: string) {
  const date = new Date(`${value}T00:00:00`);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return date.toISOString().slice(0, 10);
}

function weekHeading(value: string) {
  const start = new Date(`${value}T00:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const startText = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(start);
  const endText = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: sameMonth ? undefined : "short"
  }).format(end);
  return `${startText} – ${endText}`;
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
  const today = localIsoDate();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/roster?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load your roster.");
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load your roster.");
    } finally {
      setLoading(false);
    }
  }, [account.id, account.profileType]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedPartner = useMemo(
    () => selectedDay?.partners.find((partner) => partner.id === partnerEntryId) ?? null,
    [selectedDay, partnerEntryId]
  );
  const activeRequests = useMemo(
    () => (data?.requests ?? []).filter((request) => ["pending_partner", "pending_manager"].includes(request.status)),
    [data?.requests]
  );
  const completedRequests = useMemo(
    () => (data?.requests ?? []).filter((request) => !["pending_partner", "pending_manager"].includes(request.status)),
    [data?.requests]
  );
  const days = data?.days ?? [];
  const nextWorking = useMemo(
    () => days.find((day) => day.date >= today && day.dayType === "working" && day.shift) ?? null,
    [days, today]
  );
  const offCount = useMemo(() => days.filter((day) => day.dayType === "weekly_off").length, [days]);
  const weekGroups = useMemo(() => {
    const groups: Array<{ key: string; days: RosterDay[] }> = [];
    for (const day of days) {
      const key = weekKey(day.date);
      const current = groups[groups.length - 1];
      if (current?.key === key) current.days.push(day);
      else groups.push({ key, days: [day] });
    }
    return groups;
  }, [days]);

  function requestRow(request: SwapRequest) {
    const direction = request.isRequester
      ? `You requested with ${request.counterpart.name}`
      : `${request.counterpart.name} requested with you`;
    return (
      <article key={request.id}>
        <div>
          <i><ArrowLeftRight /></i>
          <span>
            <strong>{displayDate(request.date)} · {direction}</strong>
            <small>{shiftLabel(request.requesterShift, request.requesterDayType)} ↔ {shiftLabel(request.partnerShift, request.partnerDayType)}</small>
          </span>
          <em className={request.status}>{statusLabel[request.status]}</em>
        </div>
        {request.status === "pending_partner" && request.isPartner ? (
          <footer>
            <button className="reject" disabled={Boolean(pending)} onClick={() => void decide(request.id, "reject")}><X />Decline</button>
            <button className="accept" disabled={Boolean(pending)} onClick={() => void decide(request.id, "accept")}><Check />Accept</button>
          </footer>
        ) : null}
        {request.isRequester && ["pending_partner", "pending_manager"].includes(request.status) ? (
          <footer>
            <button className="cancel" disabled={Boolean(pending)} onClick={() => void decide(request.id, "cancel")}><X />Cancel request</button>
          </footer>
        ) : null}
      </article>
    );
  }

  async function requestSwap() {
    if (!selectedDay || !partnerEntryId) return;
    setPending("request");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/connect/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          requesterEntryId: selectedDay.id,
          partnerEntryId,
          rosterDate: selectedDay.date,
          note
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to request the swap.");
      setNotice(payload.notice);
      setSelectedDay(null);
      setPartnerEntryId("");
      setNote("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to request the swap.");
    } finally {
      setPending("");
    }
  }

  async function decide(requestId: string, action: "accept" | "reject" | "cancel") {
    setPending(`${requestId}:${action}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/connect/roster", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, requestId, action })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update the swap.");
      setNotice(payload.notice);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update the swap.");
    } finally {
      setPending("");
    }
  }

  function openSwap(day: RosterDay) {
    if (!day.canSwap || !day.partners.length) return;
    setSelectedDay(day);
    setPartnerEntryId("");
    setNote("");
  }

  function swapActionLabel(day: RosterDay) {
    if (day.canSwap && day.partners.length) return "Request swap";
    if (day.canSwap) return "No valid swap";
    return rosterChangeDeadlineShortLabel();
  }

  return (
    <section className="dx-roster">
      <header className="dx-page-intro">
        <small>My work plan</small>
        <h1>Roster</h1>
        <p>Next {data?.viewDays ?? (days.length || 7)} days · shift times and swap requests.</p>
      </header>

      {error ? (
        <div className="dx-alert error">
          <span>{error}</span>
          <button aria-label="Retry" onClick={() => void load()}><RefreshCw /></button>
        </div>
      ) : null}
      {notice ? (
        <div className="dx-alert success">
          <span>{notice}</span>
          <button aria-label="Dismiss" onClick={() => setNotice("")}><X /></button>
        </div>
      ) : null}

      {loading ? <div className="dx-loader"><span /><small>Loading roster…</small></div> : null}

      {!loading && days.length ? (
        <div className="dx-roster-summary" aria-label="Roster summary">
          <div>
            <small>Next shift</small>
            <strong>{nextWorking ? shiftLabel(nextWorking.shift, nextWorking.dayType) : "—"}</strong>
            <em>{nextWorking ? displayDate(nextWorking.date) : "No upcoming shift"}</em>
          </div>
          <div>
            <small>Rest days</small>
            <strong>{offCount}</strong>
            <em>In this view</em>
          </div>
          <div>
            <small>Open swaps</small>
            <strong>{activeRequests.length}</strong>
            <em>{activeRequests.length ? "Needs attention" : "None pending"}</em>
          </div>
        </div>
      ) : null}

      {!loading ? (
        <div className="dx-roster-panel">
          {days.length ? weekGroups.map((group) => (
            <section className="dx-roster-week-block" key={group.key}>
              <header className="dx-roster-week-label">
                <CalendarDays />
                <strong>Week of {weekHeading(group.key)}</strong>
              </header>
              <div className="dx-roster-week">
                {group.days.map((day) => {
                  const isToday = day.date === today;
                  const isOff = day.dayType === "weekly_off";
                  const canRequest = day.canSwap && day.partners.length > 0;
                  return (
                    <article
                      className={[
                        isOff ? "off" : "working",
                        isToday ? "today" : "",
                        selectedDay?.id === day.id ? "selected" : ""
                      ].filter(Boolean).join(" ")}
                      key={day.id}
                    >
                      <div className="dx-roster-date" aria-hidden="true">
                        <strong>{dayNumber(day.date)}</strong>
                        <small>{weekdayLabel(day.date)}</small>
                      </div>
                      <div className="dx-roster-shift">
                        <span>
                          <strong>{isOff ? "Weekly off" : day.shift?.name || "Working day"}</strong>
                          <small>{monthLabel(day.date)}{isToday ? " · Today" : ""}{day.isProjected ? " · Planned" : ""}</small>
                        </span>
                        <em className={isOff ? "off" : "shift"}>
                          <Clock3 />
                          {shiftLabel(day.shift, day.dayType)}
                        </em>
                      </div>
                      <button
                        aria-label={`${swapActionLabel(day)} for ${displayDate(day.date)}`}
                        className={canRequest ? "swap" : "muted"}
                        disabled={!canRequest}
                        onClick={() => openSwap(day)}
                        type="button"
                      >
                        <ArrowLeftRight />
                        <span>{canRequest ? "Swap" : "Locked"}</span>
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          )) : (
            <div className="dx-roster-empty">
              <CalendarDays />
              <strong>Your roster is not configured</strong>
              <small>Contact your HR or manager.</small>
            </div>
          )}
        </div>
      ) : null}

      {selectedDay ? (
        <>
          <button aria-label="Close swap sheet" className="dx-sheet-scrim" onClick={() => setSelectedDay(null)} type="button" />
          <div className="dx-roster-swap-card" role="dialog" aria-modal="true" aria-label="Request shift swap">
            <header>
              <div>
                <small>Swap request</small>
                <strong>{displayDate(selectedDay.date)}</strong>
                <em>{shiftLabel(selectedDay.shift, selectedDay.dayType)}</em>
              </div>
              <button aria-label="Close swap request" onClick={() => setSelectedDay(null)} type="button"><X /></button>
            </header>
            <label>
              Swap with
              <select onChange={(event) => setPartnerEntryId(event.target.value)} value={partnerEntryId}>
                <option value="">Choose colleague and shift</option>
                {selectedDay.partners.map((partner) => (
                  <option key={partner.id} value={partner.id}>
                    {partner.name || partner.code || "Colleague"} · {shiftLabel(partner.shift, partner.dayType)}
                  </option>
                ))}
              </select>
            </label>
            {selectedPartner ? (
              <div className="dx-roster-exchange">
                <span>
                  <UserRound />
                  <small>You receive</small>
                  <strong>{shiftLabel(selectedPartner.shift, selectedPartner.dayType)}</strong>
                </span>
                <ArrowLeftRight />
                <span>
                  <UserRound />
                  <small>{selectedPartner.name || "Colleague"} receives</small>
                  <strong>{shiftLabel(selectedDay.shift, selectedDay.dayType)}</strong>
                </span>
              </div>
            ) : null}
            <label>
              Note <span>(optional)</span>
              <textarea maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Add useful context" rows={2} value={note} />
            </label>
            <div className="dx-sheet-actions">
              <button className="secondary" onClick={() => setSelectedDay(null)} type="button">Cancel</button>
              <button className="dx-roster-primary" disabled={!partnerEntryId || pending === "request"} onClick={() => void requestSwap()} type="button">
                {pending === "request" ? "Sending…" : "Send request"}
              </button>
            </div>
            <small className="dx-roster-rule">Only different rosters can be exchanged. Both colleagues must agree, then your immediate manager gives final approval.</small>
          </div>
        </>
      ) : null}

      {!loading && activeRequests.length ? (
        <section className="dx-roster-requests">
          <header>
            <small>Action needed</small>
            <h2>Active swap requests</h2>
          </header>
          {activeRequests.map(requestRow)}
        </section>
      ) : null}

      {!loading && completedRequests.length ? (
        <details className="dx-roster-history">
          <summary>
            <span>
              <small>Shift changes</small>
              <strong>Recent swap history</strong>
            </span>
            <em>{completedRequests.length}</em>
          </summary>
          <section className="dx-roster-requests">{completedRequests.map(requestRow)}</section>
        </details>
      ) : null}
    </section>
  );
}

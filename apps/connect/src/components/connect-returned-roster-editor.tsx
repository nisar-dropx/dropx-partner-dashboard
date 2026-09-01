"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppAccount } from "./connect-profile-app";

type Shift = { id: string; code: string; name: string };
type DayCell = { day: string; date: string; dayType: "working" | "weekly_off"; shiftId: string; shiftCode: string };
type EditorRow = { workerType: "employee" | "contractor"; workerId: string; code: string; name: string; days: DayCell[] };
type EditorPayload = {
  planId: string;
  periodStart: string;
  periodEnd: string;
  decisionNote: string;
  approvalHistory: Array<{ round: number; decisionNote?: string | null }>;
  shifts: Shift[];
  rows: EditorRow[];
};

export function ConnectReturnedRosterEditor({ account, planId, onClose }: { account: AppAccount; planId: string; onClose: () => void }) {
  const [data, setData] = useState<EditorPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType, planId });
      const response = await fetch(`/api/connect/returned-roster?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load returned roster.");
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load returned roster.");
    } finally {
      setLoading(false);
    }
  }, [account.id, account.profileType, planId]);

  useEffect(() => { void load(); }, [load]);

  async function saveCell(row: EditorRow, day: DayCell, shiftId: string, dayType: "working" | "weekly_off") {
    setPending(`${row.workerId}:${day.date}`); setError("");
    try {
      const response = await fetch("/api/connect/returned-roster", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          planId,
          workerType: row.workerType,
          workerId: row.workerId,
          rosterDate: day.date,
          dayType,
          shiftId: dayType === "weekly_off" ? "" : shiftId
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update roster cell.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update roster cell.");
    } finally {
      setPending("");
    }
  }

  return <div className="dx-returned-roster-editor">
    <header>
      <div>
        <small>Returned roster editor</small>
        <strong>{data ? `${data.periodStart} to ${data.periodEnd}` : "Loading…"}</strong>
      </div>
      <button type="button" onClick={onClose}>Close</button>
    </header>
    {error ? <div className="dx-alert error"><span>{error}</span></div> : null}
    {data?.decisionNote ? <p className="dx-returned-roster-note"><strong>Return note:</strong> {data.decisionNote}</p> : null}
    {loading ? <div className="dx-loader"><span /><small>Loading roster grid…</small></div> : null}
    {!loading && data ? <div className="dx-returned-roster-grid-wrap">
      <table className="dx-returned-roster-grid">
        <thead>
          <tr>
            <th>Person</th>
            {data.rows[0]?.days.map((day) => <th key={day.date}>{day.day.slice(0, 3)}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => <tr key={`${row.workerType}:${row.workerId}`}>
            <td><strong>{row.name}</strong><small>{row.code}</small></td>
            {row.days.map((day) => {
              const key = `${row.workerId}:${day.date}`;
              const weeklyOff = day.dayType === "weekly_off";
              return <td key={key}>
                <select
                  disabled={pending === key}
                  value={weeklyOff ? "__wo__" : day.shiftId}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "__wo__") void saveCell(row, day, "", "weekly_off");
                    else void saveCell(row, day, value, "working");
                  }}
                >
                  <option value="">Select</option>
                  <option value="__wo__">Weekly off</option>
                  {data.shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.code}</option>)}
                </select>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div> : null}
  </div>;
}

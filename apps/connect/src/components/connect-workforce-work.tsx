"use client";

import { ArrowLeftRight, CalendarDays, Fingerprint } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AppAccount } from "./connect-profile-app";
import { ConnectAttendance } from "./connect-attendance";
import { ConnectLeave } from "./connect-leave";
import { ConnectRoster } from "./connect-roster";

type Tab = "attendance" | "roster" | "leave";

export function ConnectWorkforceWork({ account, initial = "attendance" }: { account: AppAccount; initial?: Tab }) {
  const access = account.pageAccess ?? [];
  const tabs = ([
    access.includes("attendance") ? ["attendance", "Attendance", <Fingerprint key="attendance" />] : null,
    access.includes("roster") ? ["roster", "Roster", <ArrowLeftRight key="roster" />] : null,
    access.includes("leave") || account.profileType === "contractor" ? ["leave", "Time off", <CalendarDays key="leave" />] : null
  ].filter(Boolean) as Array<[Tab, string, ReactNode]>);
  const [tab, setTab] = useState<Tab>(tabs.some(([value]) => value === initial) ? initial : tabs[0]?.[0] ?? "attendance");
  useEffect(() => { if (tabs.some(([value]) => value === initial)) setTab(initial); }, [initial, access.join(",")]);
  return <section className="dx-workforce-work"><header className="dx-page-intro"><small>My work</small><h1>Work schedule</h1><p>Keep attendance, shifts and time-off requests together.</p></header><nav aria-label="Work section" className="dx-workforce-tabs">{tabs.map(([value, name, icon]) => <button className={tab === value ? "active" : ""} key={value} onClick={() => setTab(value)}>{icon}{name}</button>)}</nav>{tab === "attendance" ? <ConnectAttendance account={account} /> : null}{tab === "roster" ? <ConnectRoster account={account} /> : null}{tab === "leave" ? <ConnectLeave account={account} /> : null}</section>;
}

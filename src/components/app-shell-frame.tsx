"use client";
import Link from "next/link";

import { Menu, X, House, ChartNoAxesCombined, ListChecks } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { EventLogTracker } from "@/components/event-log-tracker";

type AppShellFrameProps = {
  children: ReactNode;
  desktopActions: ReactNode;
  mobileActions: ReactNode;
  mobileBrand?: ReactNode;
  sidebar: ReactNode;
  financeLinks?: { href: string; label: string; icon: string }[];
};

const flashQueryKeyPattern = /^(?:error|notice|success|sent|saved|deleted|added|initialized|updated|created|uploaded)$/i;
const compoundFlashQueryKeyPattern = /_(?:sent|saved|deleted|added|initialized|updated|created|uploaded)$/i;

export function AppShellFrame({ children, desktopActions, mobileActions, mobileBrand, sidebar, financeLinks }: AppShellFrameProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname, searchParams]);

  useEffect(() => {
    document.body.classList.toggle("mobile-nav-open", sidebarOpen);
    return () => document.body.classList.remove("mobile-nav-open");
  }, [sidebarOpen]);

  useEffect(() => {
    const cleanParams = new URLSearchParams(searchParams.toString());
    let removedFlash = false;

    for (const key of Array.from(cleanParams.keys())) {
      if (
        flashQueryKeyPattern.test(key) ||
        compoundFlashQueryKeyPattern.test(key) ||
        /(?:Error|Notice|Success)$/.test(key)
      ) {
        cleanParams.delete(key);
        removedFlash = true;
      }
    }

    if (!removedFlash) return;

    const query = cleanParams.toString();
    window.history.replaceState(window.history.state, "", `${pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [pathname, searchParams]);

  return (
    <div className={`shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <EventLogTracker />
      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-menu-button"
          aria-label={sidebarOpen ? "Close menu" : "Open menu"}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((current) => !current)}
        >
          {sidebarOpen ? <X size={21} strokeWidth={2.4} /> : <Menu size={21} strokeWidth={2.4} />}
        </button>
        {mobileBrand ?? <img className="mobile-brand-logo" src="/dropx-logo.png" alt="DropX" />}
        <div className="mobile-top-actions">{mobileActions}</div>
      </header>

      {sidebarOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      {sidebar}
      {financeLinks && <nav className="finance-bottom-nav" aria-label="Finance quick navigation">
        {financeLinks.map((item) => {
          const target = item.href.split("?")[0];
          const selected = pathname === target && (!item.href.includes("tab=") || searchParams.get("tab") === "pnl");
          const Icon = item.icon === "home" ? House : item.icon === "chart" ? ChartNoAxesCombined : ListChecks;
          return <Link key={item.href} href={item.href} aria-current={selected ? "page" : undefined}><Icon size={21} /><span>{item.label}</span></Link>;
        })}
        <button type="button" onClick={() => setSidebarOpen(true)} aria-label="Open all Finance sections" aria-expanded={sidebarOpen}><Menu size={21} /><span>More</span></button>
      </nav>}

      <main className="main">
        <header className="topbar">
          <div />
          <div className="top-actions">{desktopActions}</div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}

"use client";

import { Menu, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { EventLogTracker } from "@/components/event-log-tracker";

type AppShellFrameProps = {
  children: ReactNode;
  desktopActions: ReactNode;
  mobileActions: ReactNode;
  sidebar: ReactNode;
  topLeftActions?: ReactNode;
};

const flashQueryKeyPattern = /^(?:error|notice|success|sent|saved|deleted|added|initialized|updated|created|uploaded)$/i;
const compoundFlashQueryKeyPattern = /_(?:sent|saved|deleted|added|initialized|updated|created|uploaded)$/i;

export function AppShellFrame({ children, desktopActions, mobileActions, sidebar, topLeftActions }: AppShellFrameProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

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
        <img className="mobile-brand-logo" src="/dropx-logo.png" alt="DropX" />
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

      <main className="main">
        <header className="topbar">
          <div className="top-left-actions">{topLeftActions}</div>
          <div className="top-actions">{desktopActions}</div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}

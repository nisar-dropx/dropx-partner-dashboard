"use client";

import Link from "next/link";
import { Menu, X, House, ChartNoAxesCombined, ListChecks } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { OpsDesignContext } from "@/components/ops-design-context";
import { EventLogTracker } from "@/components/event-log-tracker";

type AppShellFrameProps = {
  children: ReactNode;
  desktopActions: ReactNode;
  mobileActions: ReactNode;
  mobileBrand?: ReactNode;
  sidebar: ReactNode;
  financeLinks?: { href: string; label: string; icon: string }[];
  opsDesignPreview?: boolean;
  pageTitle?: string;
  trackEvents?: boolean;
};

const flashQueryKeyPattern = /^(?:error|notice|success|sent|saved|deleted|added|initialized|updated|created|uploaded)$/i;
const compoundFlashQueryKeyPattern = /_(?:sent|saved|deleted|added|initialized|updated|created|uploaded)$/i;

export function AppShellFrame({ children, desktopActions, mobileActions, mobileBrand, sidebar, financeLinks, opsDesignPreview = false, pageTitle, trackEvents = true }: AppShellFrameProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // OpsPulse always uses the new shell, including server render and storage-restricted browsers.
  const modern = opsDesignPreview;
  const shellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!modern) return;
    document.body.dataset.opsAppearance = "people";
    return () => { delete document.body.dataset.opsAppearance; };
  }, [modern]);

  useEffect(() => {
    if (!modern || !sidebarOpen) return;
    const sidebar = shellRef.current?.querySelector<HTMLElement>(".sidebar");
    if (!sidebar) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const background = Array.from(shellRef.current?.querySelectorAll<HTMLElement>(":scope > main, :scope > .mobile-topbar") ?? []);
    const previousInert = background.map(element => element.hasAttribute("inert"));
    background.forEach(element => { element.setAttribute("inert", ""); });
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
    sidebar.setAttribute("aria-label", "OpsPulse menu");
    const focusable = () => Array.from(sidebar.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setSidebarOpen(false); }
      if (event.key !== "Tab") return;
      const targets = focusable();
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const desktop = window.matchMedia("(min-width: 1081px)");
    const closeOnDesktop = () => { if (desktop.matches) setSidebarOpen(false); };
    document.addEventListener("keydown", keydown);
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      background.forEach((element, index) => { if (!previousInert[index]) element.removeAttribute("inert"); });
      sidebar.removeAttribute("role"); sidebar.removeAttribute("aria-modal"); sidebar.removeAttribute("aria-label");
      document.removeEventListener("keydown", keydown);
      desktop.removeEventListener("change", closeOnDesktop);
      (previousFocus?.isConnected ? previousFocus : menuRef.current)?.focus();
    };
  }, [modern, sidebarOpen]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.classList.toggle("mobile-nav-open", sidebarOpen);
    return () => document.body.classList.remove("mobile-nav-open");
  }, [sidebarOpen]);

  useEffect(() => {
    const cleanParams = new URL(window.location.href).searchParams;
    let removedFlash = false;

    for (const key of Array.from(cleanParams.keys())) {
      if (
        (modern && key === "opsUi") ||
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
  }, [pathname, searchParams, modern]);

  return (
    <OpsDesignContext.Provider value={opsDesignPreview && modern}>
    <div ref={shellRef} className={`shell ${opsDesignPreview && modern ? "ops-modern" : ""} ${sidebarOpen ? "sidebar-open" : ""}`} onClick={event => {
      const target = event.target as HTMLElement;
      if (modern && (target.closest("[data-close-ops-menu]") || target.closest(".sidebar a[href]"))) setSidebarOpen(false);
    }}>
      {modern && <a className="ops-skip-link" href="#ops-page-content">Skip to content</a>}
      {trackEvents && <EventLogTracker />}
      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-menu-button"
          ref={menuRef}
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
          {modern ? <div className="ops-page-context"><span>OpsPulse</span><span aria-hidden="true">/</span><strong>{pageTitle}</strong></div> : <div />}
          <div className="top-actions">{desktopActions}</div>
        </header>
        <div className="content" id="ops-page-content" tabIndex={-1}>{children}</div>
      </main>
    </div>
    </OpsDesignContext.Provider>
  );
}

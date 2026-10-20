"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Activity, BarChart3, Boxes, CalendarDays, ChevronDown, ClipboardCheck, FileBarChart2, FolderOpen, LayoutGrid, ListTree, MapPin, Search, Settings2, ShieldCheck, Truck, UserRoundSearch, Users, WalletCards, X, type LucideIcon } from "lucide-react";
import { PendingLink } from "@/components/pending-link";
import { PaymentNavBadge } from "@/components/payment-notification-provider";
import { activeOpsHref, searchOpsNavigation } from "@/lib/ops-pulse/design-navigation";
import type { NavItem } from "@/lib/app-navigation";

const icons: Record<string, LucideIcon> = {
  ops_pulse: Activity, performance: BarChart3, capacity: Boxes, workforce: Users,
  cod: ClipboardCheck, business_documents: FolderOpen, payments: WalletCards,
  cps: BarChart3, fleet: Truck, ops_attendance_reports: Users, ops_reports: FileBarChart2,
  ops_notification_settings: Settings2, master_data: ListTree, users: ShieldCheck,
  store_audits: ClipboardCheck, ops_rostering: CalendarDays, ops_report_bot: Activity,
  cpu_overview: BarChart3, service_network: MapPin, edd_dashboard: Truck,
  delivery_associates: Users, ops_provider_mapping: UserRoundSearch,
  ops_workforce_payouts: WalletCards, ops_workforce_advances: WalletCards, fleet_da_mapping: Truck,
};
const administration = new Set(["ops_notification_settings", "master_data", "users"]);

export function OpsDesignNavigation({ items, active }: { items: NavItem[]; active: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = useId();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const search = searchParams.toString();
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  useEffect(() => { setQuery(""); setSearchOpen(false); }, [pathname, search]);
  function closeSearch() {
    setQuery("");
    setSearchOpen(false);
    searchTrigger.current?.focus();
  }
  const selected = activeOpsHref(items, pathname, searchParams.toString(), active);
  const currentGroup = items.find(item => item.children?.some(child => child.href === selected))?.code;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (currentGroup) setExpanded(previous => ({ ...previous, [currentGroup]: true }));
  }, [currentGroup, pathname]);
  const visible = searchOpsNavigation(items, query);
  const link = (item: { code?: string; href?: string; label: string; hideBadge?: boolean }, child = false, icon?: LucideIcon) => {
    const Symbol = icon;
    const content = <>{Symbol && <Symbol size={17} aria-hidden="true" />}<span>{item.label}</span><PaymentNavBadge code={item.hideBadge ? undefined : item.code} /></>;
    return item.href ? <PendingLink key={item.label} className={`ops-design-link ${child ? "ops-design-child" : ""} ${selected === item.href ? "is-current" : ""}`} href={item.href} prefetch={false} disableWhenCurrent aria-current={selected === item.href ? "page" : undefined}>{content}</PendingLink> : <span key={item.label} className="ops-design-link unavailable">{content}</span>;
  };
  return <div className="ops-design-navigation">
    <div className="ops-menu-search-control" onKeyDown={event => { if (searchOpen && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearch(); } }}>
      <button ref={searchTrigger} type="button" className="ops-menu-search-toggle" aria-expanded={searchOpen} aria-controls={`${id}-search`} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}><Search size={15} aria-hidden="true" /><span>Search menus</span></button>
      <div id={`${id}-search`} hidden={!searchOpen}>
        {searchOpen && <div className="ops-menu-search"><input ref={searchInput} aria-label="Find a menu" placeholder="Type a menu name…" autoComplete="off" spellCheck={false} value={query} onChange={event => setQuery(event.target.value)} /><button type="button" aria-label="Close menu search" onClick={closeSearch}><X size={16} aria-hidden="true" /></button></div>}
      </div>
    </div>
    <nav aria-label="Primary" className="ops-design-nav">
      {[false, true].map(admin => {
        const group = visible.filter(item => administration.has(item.code) === admin);
        return group.length ? <section key={String(admin)} aria-label={admin ? "Administration" : "Operations"}>
          <p className="ops-nav-section">{admin ? "Administration" : "Operations"}</p>
          {group.map(item => {
            const Symbol = icons[item.code] ?? LayoutGrid;
            if (!item.children?.length) return link(item, false, Symbol);
            const open = query.trim().length > 0 || (expanded[item.code] ?? currentGroup === item.code);
            const groupId = `${id}-${item.code}`;
            return <div key={item.code} className="ops-design-group">
              <button type="button" className={`ops-design-link ops-design-group-trigger ${currentGroup === item.code ? "is-section" : ""}`} aria-expanded={open} aria-controls={groupId} onClick={() => setExpanded(previous => ({ ...previous, [item.code]: !open }))}>
                <Symbol size={17} aria-hidden="true" /><span>{item.label}</span><PaymentNavBadge code={item.code} /><ChevronDown size={14} className="ops-group-chevron" aria-hidden="true" />
              </button>
              <div className="ops-design-children" id={groupId} hidden={!open}>{item.children.map(child => link(child, true))}</div>
            </div>;
          })}
        </section> : null;
      })}
      {!visible.length && <p className="ops-nav-empty" role="status">No matching menu in your access. Try another name.</p>}
    </nav>
  </div>;
}

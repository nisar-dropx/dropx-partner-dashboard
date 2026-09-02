"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { PaymentNavBadge } from "@/components/payment-notification-provider";
import { PendingLink } from "@/components/pending-link";
import type { NavItem } from "@/lib/app-navigation";

type SidebarNavProps = {
  active: string;
  items: NavItem[];
};

export function SidebarNav({ active, items }: SidebarNavProps) {
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const submenuRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [submenuUp, setSubmenuUp] = useState<Record<string, boolean>>({});

  const updateSubmenuPosition = useCallback((key: string) => {
    const group = groupRefs.current[key];
    const submenu = submenuRefs.current[key];
    if (!group || !submenu) return;

    const groupRect = group.getBoundingClientRect();
    const submenuHeight = submenu.offsetHeight || submenu.scrollHeight;
    const viewportPadding = 12;
    const overflowsBottom = groupRect.top + submenuHeight > window.innerHeight - viewportPadding;
    const fitsAbove = groupRect.bottom - submenuHeight >= viewportPadding;
    const shouldOpenUp = overflowsBottom && fitsAbove;

    setSubmenuUp((current) => (current[key] === shouldOpenUp ? current : { ...current, [key]: shouldOpenUp }));
  }, []);

  useEffect(() => {
    function handleViewportChange() {
      for (const item of items) {
        if (item.children?.length) updateSubmenuPosition(item.label);
      }
    }

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [items, updateSubmenuPosition]);

  return (
    <nav className="nav" aria-label="Primary">
      {items.map((item) => item.children ? (
        <div
          className={`nav-group ${submenuUp[item.label] ? "submenu-up" : ""}`.trim()}
          key={item.label}
          onFocus={() => updateSubmenuPosition(item.label)}
          onMouseEnter={() => updateSubmenuPosition(item.label)}
          ref={(node) => {
            groupRefs.current[item.label] = node;
          }}
        >
          <button
            type="button"
            className={`nav-item ${active === item.label || item.children.some((child) => child.label === active) ? "active" : ""}`}
          >
            <Icon>{item.icon}</Icon>
            <span className="nav-label">{item.label}</span>
            <PaymentNavBadge code={item.code} />
            <span className="nav-caret" aria-hidden="true">&gt;</span>
          </button>
          <div
            className="nav-submenu"
            ref={(node) => {
              submenuRefs.current[item.label] = node;
            }}
          >
            {item.children.map((child) => child.href ? (
              <PendingLink className="nav-subitem" disableWhenCurrent href={child.href} key={child.label}>
                <span className="nav-label">{child.label}</span>
                <PaymentNavBadge code={item.code === "people_all" && child.code === "people_all" ? undefined : child.code} />
              </PendingLink>
            ) : (
              <span className="nav-subitem disabled" key={child.label}>{child.label}</span>
            ))}
          </div>
        </div>
      ) : item.href ? (
        <PendingLink
          className={`nav-item ${active === item.label ? "active" : ""}`}
          disableWhenCurrent
          href={item.href}
          key={item.label}
        >
          <Icon>{item.icon}</Icon>
          <span className="nav-label">{item.label}</span>
          <PaymentNavBadge code={item.code} />
        </PendingLink>
      ) : (
        <span className="nav-item disabled" key={item.label}>
          <Icon>{item.icon}</Icon>
          <span className="nav-label">{item.label}</span>
          <PaymentNavBadge code={item.code} />
        </span>
      ))}
    </nav>
  );
}

import type { ReactNode } from "react";
import { headers } from "next/headers";
import { signOut } from "@/app/login/actions";
import { AppShellFrame } from "@/components/app-shell-frame";
import { DocumentTitle } from "@/components/document-title";
import { InboxNotificationListener } from "@/components/inbox-notification-listener";
import { PaymentNotificationBell } from "@/components/payment-notification-bell";
import { PaymentNotificationProvider } from "@/components/payment-notification-provider";
import { OpsContextSwitcher } from "@/components/ops-context-switcher";
import { OpsAiChat } from "@/components/ops-ai-chat";
import { SidebarNav } from "@/components/sidebar-nav";
import { UserMenu } from "@/components/user-menu";
import { redirect } from "next/navigation";
import { opsAccessPageCodes } from "@/lib/access-surface";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { firstAllowedHref, navItems } from "@/lib/app-navigation";
import { requireCompanyId } from "@/lib/company-scope";
import { financeNavItems, hasFinancePortalAccess } from "@/lib/finance/navigation";
import { isFinanceHostName } from "@/lib/finance/surface";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import { operatingModeForLocation } from "@/lib/ops-pulse/operating-context";
import { loadPaymentNotificationSnapshot } from "@/lib/payment-notification-counts";
import { opsNavItemsForMode } from "@/lib/ops-pulse/navigation";
import { hasPeoplePortalAccess, peopleNavItems } from "@/lib/people/navigation";
import { isPeopleHostName } from "@/lib/people/surface";

export async function AppShell({ children, active, pageCode }: { children: ReactNode; active: string; pageCode?: string }) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const host = (headers().get("x-forwarded-host") ?? headers().get("host") ?? "").split(":")[0].toLowerCase();
  const isOpsHost = host === "ops.dropxlogistics.com" || host.startsWith("ops-");
  const isPeopleHost = isPeopleHostName(host);
  const isFinanceHost = isFinanceHostName(host);
  const isDashboardHost = host === "dashboard.dropxlogistics.com";
  if (isDashboardHost && !authorization.isMasterOwner) {
    redirect("/unauthorized?page=dashboard_portal&reason=super_admin_only");
  }
  const hasCurrentPortalAccess = isOpsHost
    ? isCompanyOwner(authorization) || opsAccessPageCodes.some((code) => hasPermission(authorization, code, "access"))
    : isPeopleHost
      ? hasPeoplePortalAccess(authorization)
      : isFinanceHost
        ? hasFinancePortalAccess(authorization)
      : Boolean(firstAllowedHref(authorization));
  if (!hasCurrentPortalAccess) {
    redirect(`/unauthorized?page=${isOpsHost ? "ops_portal" : isPeopleHost ? "people_portal" : isFinanceHost ? "finance_portal" : "dashboard_portal"}&reason=access`);
  }
  const opsAppUrl = process.env.OPS_APP_URL?.trim();
  const opsLocationsResult = isOpsHost
    ? await loadCodLocations(
      requireCompanyId(authorization),
      authorization.locationScopeIds,
      authorization.hasAllLocationAccess
    )
    : { locations: [], error: null };
  const opsContext = resolveOperatingContext(opsLocationsResult.locations);
  const baseShellNavItems = isOpsHost
    ? opsNavItemsForMode(opsContext.mode)
    : isPeopleHost
      ? peopleNavItems
      : isFinanceHost
        ? financeNavItems
      : navItems.map((item) => item.code === "ops_pulse" && opsAppUrl ? { ...item, href: opsAppUrl } : item);
  const shellNavItems = baseShellNavItems;

  const activeItem = shellNavItems.find((item) => item.label === active || item.children?.some((child) => child.label === active));
  const currentPageCode = pageCode ?? activeItem?.code;
  if (currentPageCode && !hasPermission(authorization, currentPageCode, "access")) {
    redirect(`/unauthorized?page=${encodeURIComponent(currentPageCode)}&reason=access`);
  }
  const visibleNavItems = shellNavItems
    .map((item) => item.children?.length ? {
      ...item,
      children: item.children.filter((child) => !child.code || hasPermission(authorization, child.code, "access"))
    } : item)
    .filter((item) => item.children?.length ? item.children.length > 0 : hasPermission(authorization, item.code, "access"));
  const inboxNotificationsEnabled = hasPermission(authorization, "inbox", "access");
  const paymentNotifications = await loadPaymentNotificationSnapshot(authorization);
  const userMenuProps = {
    action: signOut,
    email: authorization.email,
    name: authorization.fullName ?? authorization.email ?? "DropX user",
    role: authorization.roleName
  };
  const topActions = (
    <>
      {isOpsHost && opsContext.location ? (
        <OpsContextSwitcher
          availableModes={opsContext.availableModes}
          locationId={opsContext.location.id}
          locationModes={Object.fromEntries(opsLocationsResult.locations.map((location) => [location.id, operatingModeForLocation(location)]))}
          locations={opsLocationsResult.locations}
          mode={opsContext.mode}
          selectedLocationIds={opsContext.selectedLocations.map((location) => location.id)}
        />
      ) : null}
      <PaymentNotificationBell />
      <UserMenu {...userMenuProps} />
    </>
  );

  return (
    <PaymentNotificationProvider initialData={paymentNotifications}>
    <AppShellFrame
      desktopActions={topActions}
      mobileActions={topActions}
      sidebar={(
        <aside className="sidebar">
          <div className="brand">
            <img className="brand-logo" src="/dropx-logo.png" alt="DropX" />
            {isOpsHost ? (
              <div className="ops-brand-lockup">
                <span className="ops-brand-mark" aria-hidden="true">
                  <svg viewBox="0 0 32 32" role="img">
                    <path d="M4 17h5l2.7-7 4.2 14 3.4-10 2.2 3H28" />
                  </svg>
                </span>
                <span className="ops-brand-copy">
                  <strong>Ops<span>Pulse</span></strong>
                  <small>Ops intelligence</small>
                </span>
              </div>
            ) : isPeopleHost ? (
              <div className="people-brand-lockup">
                <strong>People</strong>
              </div>
            ) : isFinanceHost ? (
              <div className="people-brand-lockup">
                <strong>Finance</strong>
              </div>
            ) : null}
          </div>

          <SidebarNav active={active} items={visibleNavItems} />

          <div className="sidebar-footer">
            <strong>{authorization.fullName ?? authorization.email ?? "DropX user"}</strong>
            <br />
            {authorization.roleName ?? "Dashboard user"}
          </div>
        </aside>
      )}
    >
      <DocumentTitle pageName={active} productName={isOpsHost ? "OpsPulse · DropX" : isPeopleHost ? "DropX People" : isFinanceHost ? "DropX Finance" : "DropX Dashboard"} />
      <InboxNotificationListener enabled={inboxNotificationsEnabled} />
      {children}
      {isOpsHost && hasPermission(authorization, "ops_pulse", "access") ? <OpsAiChat /> : null}
    </AppShellFrame>
    </PaymentNotificationProvider>
  );
}

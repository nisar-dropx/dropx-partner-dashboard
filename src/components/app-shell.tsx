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
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { navItems } from "@/lib/app-navigation";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import { operatingModeForLocation } from "@/lib/ops-pulse/operating-context";
import { loadPaymentNotificationSnapshot } from "@/lib/payment-notification-counts";
import { opsNavItemsForMode } from "@/lib/ops-pulse/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforceCategoryPageCode } from "@/lib/dynamic-workforce";

const workforceCategoryRoutes: Record<string, { code: string; href: string }> = {
  employees: { code: "employees", href: "/employees" },
  field_executives: { code: "delivery_associates", href: "/field-executive" },
  contractors: { code: "contractors", href: "/contractors" },
  vendors: { code: "vendors", href: "/vendors" },
  workers: { code: "workers", href: "/workers" }
};

export async function AppShell({ children, active, pageCode }: { children: ReactNode; active: string; pageCode?: string }) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const host = headers().get("host")?.split(":")[0].toLowerCase() ?? "";
  const isOpsHost = host === "ops.dropxlogistics.com" || host.startsWith("ops-");
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
    : navItems.map((item) => item.code === "ops_pulse" && opsAppUrl ? { ...item, href: opsAppUrl } : item);
  let workforceCategories: Array<{ code: string; name: string }> = [];
  if (!isOpsHost && supabaseAdmin && authorization.companyId) {
    const categoryResult = await supabaseAdmin
      .from("workforce_categories")
      .select("code, name")
      .eq("company_id", authorization.companyId)
      .eq("is_active", true)
      .order("sort_order")
      .order("name");
    workforceCategories = categoryResult.data ?? [];
  }
  const shellNavItems = baseShellNavItems.map((item) => {
    if (item.code !== "onboard" || !workforceCategories.length) return item;
    const categoryChildren = workforceCategories.filter((category) => category.code !== "field_executives").map((category) => {
      const known = workforceCategoryRoutes[category.code];
      return known
        ? { code: known.code, label: category.name, href: known.href }
        : { code: workforceCategoryPageCode(category.code), label: category.name, href: `/people/category/${encodeURIComponent(category.code)}` };
    });
    return {
      ...item,
      children: [
        { code: "people_all", label: "All People", href: "/people/all" },
        ...categoryChildren,
        { code: "people_review", label: "Under Review", href: "/people/review" },
        { code: "people_exceptions", label: "Exception", href: "/people/exceptions" },
        { code: "people_review", label: "Workforce Lifecycle", href: "/people/workforce-lifecycle" }
      ]
    };
  });

  const activeItem = shellNavItems.find((item) => item.label === active || item.children?.some((child) => child.label === active));
  const currentPageCode = pageCode ?? activeItem?.code;
  if (currentPageCode && !hasPermission(authorization, currentPageCode, "access")) redirect("/unauthorized");
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
      <DocumentTitle pageName={active} productName={isOpsHost ? "OpsPulse · DropX" : "DropX Dashboard"} />
      <InboxNotificationListener enabled={inboxNotificationsEnabled} />
      {children}
      {isOpsHost && hasPermission(authorization, "ops_pulse", "access") ? <OpsAiChat /> : null}
    </AppShellFrame>
    </PaymentNotificationProvider>
  );
}

import { Download } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import { OpsMenuClose } from "@/components/ops-menu-close";
import { OpsPulseBrand } from "@/components/ops-pulse-brand";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { signOut } from "@/app/login/actions";
import { AppShellFrame } from "@/components/app-shell-frame";
import { DocumentTitle } from "@/components/document-title";
import { InboxNotificationListener } from "@/components/inbox-notification-listener";
import { PaymentNotificationBell } from "@/components/payment-notification-bell";
import { PaymentNotificationProvider } from "@/components/payment-notification-provider";
import { OpsWorkspaceSwitcher } from "@/components/ops-workspace-switcher";
import { OpsContextSwitcher } from "@/components/ops-context-switcher";
import { OpsAiChat } from "@/components/ops-ai-chat";
import { SidebarNav } from "@/components/sidebar-nav";
import { UserMenu } from "@/components/user-menu";
import { OwnerPreviewSwitcher } from "@/components/owner-preview-switcher";
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
import {
  applyActivitiesNavAccess,
  resolveActivitiesNavAccess,
} from "@/lib/ops-pulse/activities-nav-access";
import { opsNavItemsForMode } from "@/lib/ops-pulse/navigation";
import { isCustomWorkforceCategoryCode, workforceCategoryPageCode } from "@/lib/dynamic-workforce";
import { hasPeoplePortalAccess, peopleNavItems } from "@/lib/people/navigation";
import { isPeopleHostName } from "@/lib/people/surface";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function AppShell({ children, active, pageCode }: { children: ReactNode; active: string; pageCode?: string }) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const host = (headers().get("x-forwarded-host") ?? headers().get("host") ?? "").split(":")[0].toLowerCase();
  const isOpsHost = host === "ops.dropxlogistics.com" || host.startsWith("ops-") || host.startsWith("dropx-ops-pulse");
  const isPeopleHost = isPeopleHostName(host);
  const isFinanceHost = isFinanceHostName(host);
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
    ? opsNavItemsForMode(opsContext.mode, authorization)
    : isPeopleHost
      ? peopleNavItems
      : isFinanceHost
        ? financeNavItems
        : navItems.map((item) => item.code === "ops_pulse" && opsAppUrl ? { ...item, href: opsAppUrl } : item);
  let shellNavItems = baseShellNavItems;
  if (isPeopleHost && supabaseAdmin && authorization.companyId) {
    const categoryResult = await supabaseAdmin
      .from("workforce_categories")
      .select("code, name")
      .eq("company_id", authorization.companyId)
      .eq("is_active", true)
      .order("sort_order")
      .order("name");
    const categoryChildren = (categoryResult.data ?? [])
      .filter((category) => isCustomWorkforceCategoryCode(category.code))
      .map((category) => ({
        code: workforceCategoryPageCode(category.code),
        label: category.name,
        href: `/people/category/${encodeURIComponent(category.code)}`
      }));
    shellNavItems = baseShellNavItems.map((item) => {
      if (item.code !== "people_all" || !item.children?.length || !categoryChildren.length) return item;
      const reviewIndex = item.children.findIndex((child) => child.code === "people_review");
      const insertAt = reviewIndex < 0 ? item.children.length : reviewIndex;
      return {
        ...item,
        children: [
          ...item.children.slice(0, insertAt),
          ...categoryChildren,
          ...item.children.slice(insertAt)
        ]
      };
    });
  }

  const activeItem = shellNavItems.find((item) => item.label === active || item.children?.some((child) => child.label === active));
  // Prefer the matched child page code — parent groups (e.g. Performance) may use a
  // code the viewer does not hold, while the child (Review Desk) is what they opened.
  const activeChild = activeItem?.children?.find((child) => child.label === active);
  const currentPageCode = pageCode ?? activeChild?.code ?? activeItem?.code;
  if (currentPageCode && !hasPermission(authorization, currentPageCode, "access")) {
    redirect(`/unauthorized?page=${encodeURIComponent(currentPageCode)}&reason=access`);
  }
  const activitiesAccess =
    isOpsHost && opsContext.mode === "amazon_now"
      ? await resolveActivitiesNavAccess(authorization)
      : null;
  const navForPermissions = activitiesAccess
    ? applyActivitiesNavAccess(shellNavItems, activitiesAccess)
    : shellNavItems;
  const visibleNavItems = navForPermissions
    .map((item) => item.children?.length ? {
      ...item,
      children: item.children.filter((child) => {
        return !child.code || hasPermission(authorization, child.code, "access");
      })
    } : item)
    .filter((item) => item.children?.length ? item.children.length > 0 : hasPermission(authorization, item.code, "access"));
  const inboxNotificationsEnabled = !isFinanceHost && !authorization.isPreview && hasPermission(authorization, "inbox", "access");
  // Badge refresh runs after hydration on Ops; it must not block workspace navigation.
  const paymentNotifications = isOpsHost ? {total:0,badges:{},items:[]} : await loadPaymentNotificationSnapshot(authorization);
  const userMenuProps = {
    action: signOut,
    email: authorization.email,
    name: authorization.fullName ?? authorization.email ?? "DropX user",
    role: authorization.designationName ?? authorization.roleName
  };
  const topActions = (
    <>
      {authorization.canPreviewUsers ? <OwnerPreviewSwitcher active={Boolean(authorization.isPreview)} name={authorization.fullName ?? "user"} /> : null}
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
  const displayName = authorization.fullName ?? authorization.email ?? "DropX user";
  const displayRole = authorization.designationName ?? authorization.roleName ?? "Portal user";
  const avatarInitials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "DX";

  return (
    <PaymentNotificationProvider key={`${authorization.userId}:${authorization.isPreview}`} initialData={paymentNotifications} refreshOnMount={isOpsHost}>
    <AppShellFrame
      opsDesignPreview={isOpsHost}
      pageTitle={active}
      desktopActions={topActions}
      mobileActions={topActions}
      mobileBrand={isOpsHost ? <OpsPulseBrand /> : undefined}
      sidebar={(
        <aside className="sidebar">
          {isOpsHost && <OpsMenuClose />}
          <div className="brand">
            <img className="brand-logo" src="/dropx-logo.png" alt="DropX" />
            {isOpsHost ? (
              <OpsPulseBrand />
            ) : isPeopleHost ? (
              <div className="people-brand-lockup">
                <strong>People</strong>
              </div>
            ) : isFinanceHost ? (
              <div className="people-brand-lockup"><strong>Finance</strong></div>
            ) : null}
          </div>

          {isOpsHost&&<OpsWorkspaceSwitcher modes={opsContext.availableModes} mode={opsContext.mode}/>}
          <SidebarNav opsDesign={isOpsHost} active={active} items={visibleNavItems} prefetch={!(isOpsHost && pageCode === "ops_pulse")} />

          <div className={isOpsHost ? "sidebar-user ops-sidebar-user" : "sidebar-footer"}>
            {isOpsHost ? (
              <>
                <div className="avatar" aria-hidden="true">{avatarInitials}</div>
                <div>
                  <strong>{displayName}</strong>
                  <small>{displayRole}</small>
                </div>
                <form action={signOut}>
                  <SubmitButton className="link-button" pendingText="Signing out…">Sign out</SubmitButton>
                </form>
                <a className="ops-sidebar-install" href="/downloads/app">
                  <Download size={14} aria-hidden="true" /> Get the OpsPulse app
                </a>
              </>
            ) : (
              <>
                <strong>{displayName}</strong>
                <span>{displayRole}</span>
              </>
            )}
          </div>
        </aside>
      )}
    >
      <DocumentTitle pageName={active} productName={isOpsHost ? "OpsPulse · DropX" : isPeopleHost ? "DropX People" : isFinanceHost ? "DropX Finance" : "DropX Dashboard"} />
      <InboxNotificationListener enabled={inboxNotificationsEnabled} />
      {authorization.isPreview ? <div className="owner-preview-banner"><strong>Read-only user preview</strong><span>You are viewing this portal as {authorization.fullName}. Exit preview to make changes.</span></div> : null}
      {children}
      {isOpsHost && hasPermission(authorization, "ops_pulse", "access") ? <OpsAiChat /> : null}
    </AppShellFrame>
    </PaymentNotificationProvider>
  );
}

import { hasPermission, type AuthorizationContext } from "@/lib/authorization";

export type CapacityWorkspaceTab = "overview" | "associates" | "delivery" | "distance";
export type CapacityViewTab = "operations" | "hiring";

export function allowedCapacityWorkspaceTabs(authorization: AuthorizationContext): CapacityWorkspaceTab[] {
  return [
    hasPermission(authorization, "capacity_overview", "access") ? "overview" : null,
    hasPermission(authorization, "capacity_associates", "access") ? "associates" : null,
    hasPermission(authorization, "capacity_delivery", "access") ? "delivery" : null,
    hasPermission(authorization, "capacity_associates", "access") ? "distance" : null
  ].filter((tab): tab is CapacityWorkspaceTab => Boolean(tab));
}

export function allowedCapacityViewTabs(authorization: AuthorizationContext): CapacityViewTab[] {
  return [
    hasPermission(authorization, "capacity_overview", "access") ? "operations" : null,
    hasPermission(authorization, "capacity_hiring", "access") ? "hiring" : null
  ].filter((tab): tab is CapacityViewTab => Boolean(tab));
}

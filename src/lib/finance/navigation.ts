import type { NavItem } from "@/lib/app-navigation";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { financeAccessPageCodes } from "@/lib/finance/surface";

export const financeNavItems: NavItem[] = [
  { code: "payments", label: "Finance Dashboard", href: "/finance", icon: "#" },
  {
    code: "payments",
    label: "Finance Operations",
    icon: "₹",
    children: [
      { code: "advance_requests", label: "Advance Requests", href: "/payments/advance-request" },
      { code: "expense_requests", label: "Expense Requests", href: "/payments/expense-request" },
      { code: "payment_requests", label: "Payment Requests", href: "/payments/requests" },
      { code: "payment_approvals", label: "Approvals", href: "/payments/approvals" },
      { code: "payment_process", label: "Payment Process", href: "/payments/process" },
      { code: "workforce_payouts", label: "Workforce Payouts", href: "/payments/workforce-payouts" },
      { code: "payment_reports", label: "Reports", href: "/payments/report" }
    ]
  },
  {
    code: "finance_pricing",
    label: "Master",
    icon: "*",
    children: [
      { code: "finance_pricing", label: "Pricing Master", href: "/master/pricing" },
      { code: "payment_methods", label: "Payment Methods", href: "/master/payment-methods" },
      { code: "master_payment_banks", label: "Payment Banks", href: "/master/payment-banks" },
      { code: "master_payment_heads", label: "Payment Heads", href: "/master/payment-heads" },
      { code: "master_contacts", label: "Contacts", href: "/master/contacts" }
    ]
  },
  { code: "finance_revenue", label: "Business Performance", icon: "↗", children: [
    { code: "finance_revenue", label: "Revenue & Billing", href: "/finance/business?tab=revenue" },
    { code: "finance_pnl", label: "Profit & Loss", href: "/finance/business?tab=pnl" }
  ] },
  { code: "payment_settings", label: "Finance Settings", href: "/settings/payments", icon: "S" },
  {
    code: "users",
    label: "Users & Access",
    icon: "@",
    children: [
      { code: "users", label: "Users", href: "/users?section=users" },
      { code: "users", label: "Finance Roles", href: "/users?section=roles" },
      { code: "users", label: "Delegation", href: "/users/positions" }
    ]
  }
];

const financePageCodeSet = new Set<string>(financeAccessPageCodes);

export function isFinancePortalPageCode(code: string) {
  return financePageCodeSet.has(code);
}

function canAccess(authorization: AuthorizationContext, code?: string) {
  if (!code) return true;
  return hasPermission(authorization, code, "access");
}

export function hasFinancePortalAccess(authorization: AuthorizationContext) {
  return financeAccessPageCodes.some((code) => canAccess(authorization, code));
}

export function firstAllowedFinanceHref(authorization: AuthorizationContext) {
  for (const item of financeNavItems) {
    if (item.href && canAccess(authorization, item.code)) return item.href;
    const child = item.children?.find((entry) => entry.href && canAccess(authorization, entry.code));
    if (child?.href) return child.href;
  }
  return null;
}

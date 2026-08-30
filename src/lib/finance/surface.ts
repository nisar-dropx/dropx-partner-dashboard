const financePortalRoots = [
  "/finance",
  "/payments",
  "/master/payment-methods",
  "/master/payment-banks",
  "/master/payment-heads",
  "/master/contacts",
  "/settings/payments",
  "/settings/notification-templates/payments",
  "/users",
  "/unauthorized"
] as const;

export const financeAccessPageCodes = [
  "payments",
  "advance_requests",
  "expense_requests",
  "payment_requests",
  "payment_approvals",
  "payment_process",
  "workforce_payouts",
  "payment_reports",
  "payment_methods",
  "master_payment_banks",
  "master_payment_heads",
  "master_contacts",
  "payment_settings",
  "users"
] as const;

export function isFinanceHostName(host: string) {
  const normalized = host.split(":")[0].trim().toLowerCase();
  return normalized === "fin.dropxlogistics.com" ||
    normalized === "finance.dropxlogistics.com" ||
    normalized.startsWith("fin-") ||
    normalized.startsWith("fin.") ||
    normalized.startsWith("finance-") ||
    normalized.startsWith("finance.");
}

export function isFinancePortalPath(pathname: string) {
  const path = pathname || "/";
  if (path === "/") return true;
  return financePortalRoots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function safeFinanceNextPath(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("/") || text.startsWith("//") || text.startsWith("/login")) return "/";
  try {
    const parsed = new URL(text, "https://fin.dropxlogistics.com");
    if (!isFinancePortalPath(parsed.pathname)) return "/";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

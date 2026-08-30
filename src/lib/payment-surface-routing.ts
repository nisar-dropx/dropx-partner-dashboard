export const dashboardOpsPaymentPaths = [
  "/payments/advance-request",
  "/payments/expense-request",
  "/payments/requests",
  "/payments/approvals",
  "/payments/report"
] as const;

export const dashboardFinancePaths = [
  "/payments/process",
  "/payments/workforce-payouts",
  "/master/payment-methods",
  "/master/payment-banks",
  "/master/payment-heads",
  "/master/contacts",
  "/settings/payments",
  "/settings/notification-templates/payments"
] as const;

function matchesPath(path: string, roots: readonly string[]) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function dashboardPaymentDestination(path: string) {
  if (path === "/payments") return { product: "operations" as const, path: "/payments/requests" };
  if (matchesPath(path, dashboardOpsPaymentPaths)) return { product: "operations" as const, path };
  if (matchesPath(path, dashboardFinancePaths)) return { product: "finance" as const, path };
  return null;
}

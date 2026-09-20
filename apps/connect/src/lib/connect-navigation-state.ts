type Account = {
  id: string;
  companyId: string;
  profileType: string;
  pageAccess?: string[];
};

export type ReporteeCheck = {
  accountKey: string;
  status: "loading" | "ready" | "error";
  hasReportees?: boolean;
};

export function resolveApprovalAccess(
  account: Account | null,
  workforceWorkspace: boolean,
  check: ReporteeCheck | null
): "allowed" | "denied" | "loading" | "error" {
  if (!account || workforceWorkspace) return "denied";
  if (account.profileType === "user" || account.pageAccess?.includes("approvals")) return "allowed";
  const key = `${account.profileType}:${account.companyId}:${account.id}`;
  if (!check || check.accountKey !== key || check.status === "loading") return "loading";
  if (check.status === "error") return "error";
  return check.hasReportees ? "allowed" : "denied";
}

export function leaveRouteState(step: string) {
  return step === "wfh"
    ? { screen: "leave" as const, section: "wfh" as const }
    : { screen: "leave" as const, section: "leave" as const };
}

export async function readConnectSessionResponse<T extends { authenticated: boolean; accounts?: unknown[]; error?: string }>(
  response: Response
): Promise<T> {
  const payload = await response.json().catch(() => null);
  const explicitlySignedOut = (response.status === 401 || response.status === 403)
    && payload?.authenticated === false;
  if ((!response.ok && !explicitlySignedOut)
    || typeof payload?.authenticated !== "boolean"
    || (payload.authenticated && !Array.isArray(payload.accounts))) {
    throw new Error("Unable to load your workspace. Please retry.");
  }
  return payload as T;
}

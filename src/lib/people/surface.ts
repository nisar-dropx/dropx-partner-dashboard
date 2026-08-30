const peoplePortalRoots = [
  "/people",
  "/employees",
  "/attendance",
  "/imports",
  "/report-upload",
  "/inbox",
  "/notifications",
  "/users",
  "/master",
  "/settings",
  "/biometric",
  "/trash",
  "/unauthorized"
] as const;

const peoplePortalDeniedRoots = [
  "/payments",
  "/reports/raw-punches",
  "/reports/verification-api",
  "/reports/event-log",
  "/master/location",
  "/master/providers",
  "/master/payment-methods",
  "/master/payment-banks",
  "/master/payment-heads",
  "/master/contacts",
  "/master/workforce-categories",
  "/master/workforce-whatsapp",
  "/master/biometric-devices",
  "/master/documents",
  "/settings/verification-apis",
  "/settings/biometric"
] as const;

export function isPeopleHostName(host: string) {
  const normalized = host.split(":")[0].trim().toLowerCase();
  return normalized === "people.dropxlogistics.com" ||
    normalized === "hrms.dropxlogistics.com" ||
    normalized === "dropx-hrms.vercel.app" ||
    normalized.startsWith("people-") ||
    normalized.startsWith("people.") ||
    normalized.startsWith("hrms-") ||
    normalized.startsWith("hrms.") ||
    normalized.startsWith("dropx-hrms-");
}

export function isPeoplePortalPath(pathname: string) {
  const path = pathname || "/";
  if (path === "/") return true;
  if (peoplePortalDeniedRoots.some((root) => path === root || path.startsWith(`${root}/`))) return false;
  return peoplePortalRoots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function safePeopleNextPath(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("/") || text.startsWith("//") || text.startsWith("/login")) return "/";
  try {
    const parsed = new URL(text, "https://people.dropxlogistics.com");
    if (!isPeoplePortalPath(parsed.pathname)) return "/";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

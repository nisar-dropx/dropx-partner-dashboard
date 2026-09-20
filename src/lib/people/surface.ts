const peoplePortalRoots = [
  "/people",
  "/employees",
  "/field-executive",
  "/workforce",
  "/contractors",
  "/vendors",
  "/workers",
  "/helpers",
  "/rostering",
  "/attendance",
  "/reports/raw-punches",
  "/reports/verification-api",
  "/reports/event-log",
  "/imports",
  "/report-upload",
  "/inbox",
  "/business-documents",
  "/payments",
  "/notifications",
  "/users",
  "/master",
  "/settings",
  "/biometric",
  "/trash",
  "/unauthorized"
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

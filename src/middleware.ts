import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isPeopleHostName, isPeoplePortalPath } from "@/lib/people/surface";
import { timeoutFetch } from "@/lib/timeout-fetch";
import { withTimeout } from "@/lib/with-timeout";
import { isFinanceHostName, isFinancePortalPath } from "@/lib/finance/surface";
import { LEGACY_OPS_AUTH_KEY, sharedAuthStorageKey, isTransientAuthFailure, SessionUnavailableError } from "@/lib/auth-session-policy";
import { providerMappingPageCodeForHost } from "@/lib/provider-mapping-host";

const AUTH_TIMEOUT_MS = 5000;
const AUTH_CLAIMS_TIMEOUT_MS = 3000;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAuthKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const COOKIE_CHUNK_SIZE = 3000;
const MAX_COOKIE_CHUNKS = 8;
const ENCODED_COOKIE_PREFIX = "b64-";
const CLEAN_OPS_ROOTS = ["/attendance", "/team-ops", "/daily-submission", "/performance", "/capacity", "/service-network", "/rostering", "/workforce", "/field-executive", "/work-force-register", "/cod", "/edd", "/station-edd", "/reports", "/client", "/access", "/audits", "/unauthorized"];
// Only these specific /master/* subpaths live under src/app/ops-pulse/master/* and need the
// /ops-pulse prefix rewritten in; every other /master/* path (performance-targets, cod-master,
// designations, ...) is a real top-level route under src/app/master/* already, so this list
// must stay a narrow allowlist, not the whole /master root — otherwise every other Master page
// would get double-rewritten to a path that doesn't exist under ops-pulse and 404 instead.
const CLEAN_OPS_MASTER_SUBPATHS = ["/master/service-network", "/master/audits", "/master/loss-recovery"];
const MOVED_OPS_PAYMENT_PATHS = [
  "/payments/advance-request",
  "/payments/expense-request",
  "/payments/requests",
  "/payments/approvals",
  "/payments/workforce-payouts",
  "/payments/workforce-advances",
  "/payments/report"
];
const DEPRECATED_MAIN_PEOPLE_PATHS = ["/people", "/field-executive", "/vendors", "/workers"];
const DEPRECATED_MAIN_HR_PATHS = ["/employees", "/contractors"];
const RESTORED_DASHBOARD_PEOPLE_PATHS = [
  "/people/all",
  "/people/workforce",
  "/people/review",
  "/people/exceptions",
  "/people/workforce-lifecycle",
  "/workforce",
  "/field-executive",
  "/employees",
  "/contractors",
  "/workers",
  "/helpers",
  "/vendors",
  "/attendance/integrity"
];

function matchesPath(path: string, roots: string[]) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function cleanOpsPath(path: string) {
  if (path === "/ops-pulse") return "/";
  return path.startsWith("/ops-pulse/") ? path.slice("/ops-pulse".length) : path;
}

function isCleanOpsPath(path: string) {
  return path === "/" ||
    CLEAN_OPS_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)) ||
    CLEAN_OPS_MASTER_SUBPATHS.some((root) => path === root || path.startsWith(`${root}/`));
}

function isMovedOpsPaymentPath(path: string) {
  return MOVED_OPS_PAYMENT_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
}

function isAssetPath(path: string) {
  return /\.[a-z0-9]{2,8}$/i.test(path);
}

function isPublicOpsInstallAsset(path: string) {
  return path === "/manifest.webmanifest" ||
    path === "/sw.js" ||
    path.startsWith("/opspulse/") ||
    path.startsWith("/downloads/") ||
    path.startsWith("/.well-known/");
}

function isPublicAppPath(path: string) {
  return path === "/login" ||
    path.startsWith("/api/") ||
    path.startsWith("/auth/") ||
    path.startsWith("/_next/") ||
    isPublicOpsInstallAsset(path) ||
    isAssetPath(path);
}

function surfaceDeniedUrl(request: NextRequest, portalPage: string, requestedPath: string) {
  const deniedUrl = request.nextUrl.clone();
  deniedUrl.pathname = "/unauthorized";
  deniedUrl.search = "";
  deniedUrl.searchParams.set("page", portalPage);
  deniedUrl.searchParams.set("reason", "surface");
  deniedUrl.searchParams.set("requested", requestedPath);
  return deniedUrl;
}

function encodeCookieValue(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return ENCODED_COOKIE_PREFIX + btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCookieValue(value: string) {
  if (!value.startsWith(ENCODED_COOKIE_PREFIX)) return value;
  const encoded = value.slice(ENCODED_COOKIE_PREFIX.length)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hasVerifiedSessionClaims(supabase: {
  auth: {
    getClaims?: () => Promise<{ data?: { claims?: Record<string, unknown> | null } | null; error?: unknown }>;
  };
}) {
  const getClaims = supabase.auth.getClaims;
  if (typeof getClaims !== "function") return false;
  try {
    const result = await withTimeout(getClaims.call(supabase.auth), AUTH_CLAIMS_TIMEOUT_MS, "Session claim check");
    if (result.error && isTransientAuthFailure(result.error)) throw new SessionUnavailableError();
    return typeof result.data?.claims?.sub === "string";
  } catch (error) {
    if (isTransientAuthFailure(error) || error instanceof SessionUnavailableError) throw new SessionUnavailableError();
    throw error;
  }
}

function unavailableSessionResponse() {
  return new NextResponse("We could not verify your signed-in session. Please reload this page.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "5"
    }
  });
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname || "/";
  // Workspace selection only changes a view preference, with the preview user's
  // authorized locations rechecked by the endpoint; it cannot change business data.
  if (request.cookies.get("dropx_portal_preview_v1")?.value && !["GET", "HEAD", "OPTIONS"].includes(request.method) && path !== "/api/owner-preview" && path !== "/api/ops-pulse/workspace") {
    return NextResponse.json({ error: "User preview is read-only. Exit preview to make changes." }, { status: 403 });
  }
  const host = request.headers.get("host")?.split(":")[0].toLowerCase() ?? "";
  const isPlatformAdminHost = host === "admin-panel.dropxlogistics.com";
  const isOpsHost = host === "ops.dropxlogistics.com";
  const isPeopleHost = isPeopleHostName(host);
  const isFinanceHost = isFinanceHostName(host);
  const isDashboardHost = host === "dashboard.dropxlogistics.com";
  const isLegacyProviderMappingIndex = path === "/provider-mapping" || path === "/provider-mapping/provider-first";
  const isProviderMappingPath = path === "/provider-id-mapping" || path === "/provider-mapping" || path.startsWith("/provider-mapping/");
  const isSharedOpsPath = path === "/fleet" || path.startsWith("/fleet/") ||
    path === "/business-documents" || path.startsWith("/business-documents/") ||
    isProviderMappingPath;

  if (isProviderMappingPath && !providerMappingPageCodeForHost(host)) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "provider_mapping_portal", path));
  }

  if (isLegacyProviderMappingIndex) {
    const canonicalUrl = request.nextUrl.clone();
    canonicalUrl.pathname = "/provider-id-mapping";
    return NextResponse.redirect(canonicalUrl, 308);
  }

  if (isDashboardHost && (path === "/ops-pulse" || path.startsWith("/ops-pulse/"))) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "dashboard_portal", path));
  }

  const isRestoredDashboardPeoplePath = isDashboardHost && matchesPath(path, RESTORED_DASHBOARD_PEOPLE_PATHS);

  if (isDashboardHost && !isRestoredDashboardPeoplePath && matchesPath(path, DEPRECATED_MAIN_PEOPLE_PATHS)) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "dashboard_portal", path));
  }

  if (isDashboardHost && !isRestoredDashboardPeoplePath && matchesPath(path, DEPRECATED_MAIN_HR_PATHS)) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "dashboard_portal", path));
  }

  if (!isPlatformAdminHost && path === "/platform-admin") {
    return NextResponse.redirect(surfaceDeniedUrl(request, "platform_admin_portal", path));
  }

  if (
    isPlatformAdminHost &&
    !isPublicAppPath(path) &&
    path !== "/" &&
    path !== "/platform-admin" &&
    path !== "/unauthorized"
  ) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "platform_admin_portal", path));
  }

  if (isOpsHost && (path === "/ops-pulse" || path.startsWith("/ops-pulse/"))) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = cleanOpsPath(path);
    return NextResponse.redirect(redirectUrl);
  }

  // Losses moved out of /attendance; old bookmarks and shared links keep working.
  if (isOpsHost && (path === "/attendance/losses" || path.startsWith("/attendance/losses/"))) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = `/team-ops/losses${path.slice("/attendance/losses".length)}`;
    return NextResponse.redirect(redirectUrl, 308);
  }

  if (isOpsHost && path.startsWith("/payments/") && !isMovedOpsPaymentPath(path)) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "ops_portal", path));
  }

  // Legacy Manage-in-People deep links used /people/employees|contractors/:id.
  const legacyPeopleEmployee = path.match(/^\/people\/employees\/([^/]+)\/?$/);
  if (isPeopleHost && legacyPeopleEmployee) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/employees";
    redirectUrl.search = "";
    redirectUrl.searchParams.set("edit", legacyPeopleEmployee[1]);
    return NextResponse.redirect(redirectUrl);
  }
  const legacyPeopleContractor = path.match(/^\/people\/contractors\/([^/]+)\/?$/);
  if (isPeopleHost && legacyPeopleContractor) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/contractors";
    redirectUrl.search = "";
    redirectUrl.searchParams.set("edit", legacyPeopleContractor[1]);
    return NextResponse.redirect(redirectUrl);
  }

  if (isPeopleHost && !isPublicAppPath(path) && !isPeoplePortalPath(path)) {
    const peopleHomeUrl = request.nextUrl.clone();
    peopleHomeUrl.pathname = "/";
    peopleHomeUrl.search = "";
    return NextResponse.redirect(peopleHomeUrl);
  }

  if (isFinanceHost && !isPublicAppPath(path) && !isFinancePortalPath(path)) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "finance_portal", path));
  }

  if (
    isOpsHost &&
    path !== "/login" &&
    !isCleanOpsPath(path) &&
    !isMovedOpsPaymentPath(path) &&
    !isSharedOpsPath &&
    path !== "/settings/notifications" &&
    !path.startsWith("/cps") &&
    !path.startsWith("/cpu") &&
    !path.startsWith("/master/") &&
    !path.startsWith("/users") &&
    !path.startsWith("/api/") &&
    !path.startsWith("/auth/") &&
    !path.startsWith("/_next/") &&
    !isPublicOpsInstallAsset(path) &&
    !isAssetPath(path)
  ) {
    const deniedUrl = request.nextUrl.clone();
    deniedUrl.pathname = "/unauthorized";
    deniedUrl.search = "";
    deniedUrl.searchParams.set("reason", "surface");
    deniedUrl.searchParams.set("requested", path);
    return NextResponse.redirect(deniedUrl);
  }

  if (request.nextUrl.pathname === "/partner" || request.nextUrl.pathname.startsWith("/partner/")) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = request.nextUrl.pathname.replace(/^\/partner/, "") || "/";
    return NextResponse.redirect(redirectUrl);
  }

  if (isPublicAppPath(path)) {
    return NextResponse.next();
  }

  if (!supabaseUrl || !supabaseAuthKey) {
    return NextResponse.redirect(new URL("/login?error=Authentication%20is%20not%20configured", request.url));
  }

  const response = NextResponse.next();
  const cookieDomain = host.endsWith("dropxlogistics.com") ? ".dropxlogistics.com" : undefined;
  const cookieOptions = {
    domain: cookieDomain,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  };
  const expireCookie = (name: string) => {
    request.cookies.set(name, "");
    response.cookies.set(name, "", { ...cookieOptions, maxAge: 0 });
  };
  const clearStoredValue = (key: string) => {
    expireCookie(key);
    for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) expireCookie(`${key}.${index}`);
  };
  const readStoredValue = (key: string) => {
    const legacyValue = request.cookies.get(key)?.value;
    if (legacyValue) return decodeCookieValue(legacyValue);

    let value = "";
    for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) {
      const chunk = request.cookies.get(`${key}.${index}`)?.value;
      if (!chunk) break;
      value += chunk;
    }
    return value ? decodeCookieValue(value) : null;
  };
  const storageKey = sharedAuthStorageKey(supabaseUrl);
  const legacyOpsValue = isOpsHost && !readStoredValue(storageKey) ? readStoredValue(LEGACY_OPS_AUTH_KEY) : null;
  const getStoredValue = (key: string) => readStoredValue(key) || (key === storageKey ? legacyOpsValue : null);
  const setStoredValue = (key: string, value: string) => {
    clearStoredValue(key);
    const encodedValue = encodeCookieValue(value);
    const chunks = encodedValue.match(new RegExp(`.{1,${COOKIE_CHUNK_SIZE}}`, "g")) ?? [];
    chunks.forEach((chunk, index) => {
      const name = `${key}.${index}`;
      request.cookies.set(name, chunk);
      response.cookies.set(name, chunk, cookieOptions);
    });
  };
  const supabase = createClient(supabaseUrl, supabaseAuthKey, {
    auth: {
      flowType: "pkce",
      storageKey,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage: {
        getItem: getStoredValue,
        setItem: setStoredValue,
        removeItem: clearStoredValue
      }
    },
    global: {
      fetch: timeoutFetch()
    }
  });

  // Verify the signed access token locally first. This runs for every page
  // navigation and link prefetch, so asking the Auth API (and the database
  // behind it) each time is the single largest source of background load. The
  // Auth API is only consulted when the token cannot be verified locally.
  const copySessionCookies = (target: NextResponse) => {
    response.cookies.getAll().forEach(cookie => target.cookies.set(cookie));
    target.headers.set("Cache-Control", "private, no-store");
    return target;
  };
  const loginResponse = () => {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return copySessionCookies(NextResponse.redirect(loginUrl));
  };
  try {
    if (!(await hasVerifiedSessionClaims(supabase))) {
      const { data, error } = await withTimeout(supabase.auth.getUser(), AUTH_TIMEOUT_MS, "Session check");
      if (error && isTransientAuthFailure(error)) return copySessionCookies(unavailableSessionResponse());
      if (!data.user) return loginResponse();
    }
  } catch (error) {
    if (isTransientAuthFailure(error) || error instanceof SessionUnavailableError) return copySessionCookies(unavailableSessionResponse());
    throw error;
  }

  // Persist a verified legacy Ops session once; never maintain two copies of
  // one rotating refresh token. The shared cookie wins when both are present.
  if (legacyOpsValue && !readStoredValue(storageKey)) setStoredValue(storageKey, legacyOpsValue);
  if (isOpsHost) {
    for (const name of [LEGACY_OPS_AUTH_KEY, ...Array.from({ length: MAX_COOKIE_CHUNKS }, (_, i) => `${LEGACY_OPS_AUTH_KEY}.${i}`)]) {
      if (!request.cookies.get(name)?.value) continue;
      request.cookies.delete(name);
      response.cookies.set(name, "", { ...cookieOptions, domain: undefined, maxAge: 0 });
    }
  }
  const forwardSession = (rewriteUrl?: URL) => {
    // response cookies alone reach the browser, but not the current page/action.
    const init = { request: { headers: request.headers } };
    const next = rewriteUrl ? NextResponse.rewrite(rewriteUrl, init) : NextResponse.next(init);
    response.cookies.getAll().forEach(cookie => next.cookies.set(cookie));
    next.headers.set("Cache-Control", "private, no-store");
    return next;
  };

  if (isPlatformAdminHost && path === "/") {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = "/platform-admin";
    return forwardSession(rewriteUrl);
  }

  if (isOpsHost && path !== "/unauthorized" && isCleanOpsPath(path)) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = path === "/" ? "/ops-pulse" : `/ops-pulse${path}`;
    return forwardSession(rewriteUrl);
  }

  return forwardSession();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|favicon.png|dropx-logo.jpg|dropx-logo.png).*)"]
};

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isPeopleHostName, isPeoplePortalPath } from "@/lib/people/surface";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAuthKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const COOKIE_CHUNK_SIZE = 3000;
const MAX_COOKIE_CHUNKS = 8;
const ENCODED_COOKIE_PREFIX = "b64-";
const CLEAN_OPS_ROOTS = ["/attendance", "/daily-submission", "/performance", "/capacity", "/service-network", "/field-executive", "/work-force-register", "/cod", "/edd", "/reports", "/client", "/access", "/unauthorized"];
const MOVED_OPS_PAYMENT_PATHS = [
  "/payments/advance-request",
  "/payments/expense-request",
  "/payments/requests",
  "/payments/approvals",
  "/payments/report"
];
const DEPRECATED_MAIN_PEOPLE_PATHS = ["/people", "/field-executive", "/vendors", "/workers"];
const DEPRECATED_MAIN_HR_PATHS = ["/employees", "/contractors"];
const RESTORED_DASHBOARD_PEOPLE_PATHS = [
  "/people/all",
  "/people/review",
  "/people/exceptions",
  "/people/workforce-lifecycle",
  "/field-executive",
  "/employees",
  "/contractors",
  "/workers",
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
  return path === "/" || CLEAN_OPS_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
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

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname || "/";
  const host = request.headers.get("host")?.split(":")[0].toLowerCase() ?? "";
  const isPlatformAdminHost = host === "admin-panel.dropxlogistics.com";
  const isOpsHost = host === "ops.dropxlogistics.com";
  const isPeopleHost = isPeopleHostName(host);
  const isDashboardHost = host === "dashboard.dropxlogistics.com";
  const isSharedOpsPath = path === "/fleet" || path.startsWith("/fleet/") ||
    path === "/business-documents" || path.startsWith("/business-documents/");

  if (isDashboardHost && (path === "/ops-pulse" || path.startsWith("/ops-pulse/"))) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "dashboard_portal", path));
  }

  const isRestoredDashboardPeoplePath = isDashboardHost && matchesPath(path, RESTORED_DASHBOARD_PEOPLE_PATHS);

  if (isDashboardHost && !isRestoredDashboardPeoplePath && matchesPath(path, DEPRECATED_MAIN_PEOPLE_PATHS)) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "dashboard_portal", path));
  }

  if (isDashboardHost && matchesPath(path, DEPRECATED_MAIN_HR_PATHS)) {
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

  if (isOpsHost && path.startsWith("/payments/") && !isMovedOpsPaymentPath(path)) {
    return NextResponse.redirect(surfaceDeniedUrl(request, "ops_portal", path));
  }

  if (isPeopleHost && !isPublicAppPath(path) && !isPeoplePortalPath(path)) {
    const peopleHomeUrl = request.nextUrl.clone();
    peopleHomeUrl.pathname = "/";
    peopleHomeUrl.search = "";
    return NextResponse.redirect(peopleHomeUrl);
  }

  if (
    isOpsHost &&
    path !== "/login" &&
    !isCleanOpsPath(path) &&
    !isMovedOpsPaymentPath(path) &&
    !isSharedOpsPath &&
    !path.startsWith("/cps") &&
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
    ...(isOpsHost ? {} : { domain: cookieDomain }),
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
  const getStoredValue = (key: string) => {
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
      ...(isOpsHost ? { storageKey: "dropx-ops-auth-v3" } : {}),
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage: {
        getItem: getStoredValue,
        setItem: setStoredValue,
        removeItem: clearStoredValue
      }
    }
  });

  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isPlatformAdminHost && path === "/") {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = "/platform-admin";
    return NextResponse.rewrite(rewriteUrl);
  }

  if (isOpsHost && path !== "/unauthorized" && isCleanOpsPath(path)) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = path === "/" ? "/ops-pulse" : `/ops-pulse${path}`;
    const rewriteResponse = NextResponse.rewrite(rewriteUrl);
    response.cookies.getAll().forEach((cookie) => rewriteResponse.cookies.set(cookie));
    return rewriteResponse;
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|favicon.png|dropx-logo.jpg|dropx-logo.png).*)"]
};

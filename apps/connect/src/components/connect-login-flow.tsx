"use client";

import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { ArrowLeftRight, Bell, CalendarDays, CheckCheck, ChevronRight, ClipboardCheck, ClipboardList, CreditCard, Files, Fingerprint, Gauge, Home, IndianRupee, LockKeyhole, LogOut, Menu, MessageCircleMore, ReceiptText, Settings, ShieldCheck, Sparkles, SwitchCamera, Target, UserRound, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConnectAttendance } from "./connect-attendance";
import { AttendanceLocationMonitor } from "./attendance-location-monitor";
import { ConnectNativeBridge } from "./connect-native-bridge";
import { ConnectAppInstallCard } from "./connect-app-install-card";
import { ConnectDashboard } from "./connect-dashboard";
import { ConnectDocuments } from "./connect-documents";
import { ConnectLeave } from "./connect-leave";
import { ConnectRoster } from "./connect-roster";
import { ConnectAdvances } from "./connect-advances";
import { ConnectPerformance } from "./connect-performance";
import { ConnectReimbursements } from "./connect-reimbursements";
import { ConnectApprovalInbox } from "./connect-approval-inbox";
import { ConnectMyRequests } from "./connect-my-requests";
import { ConnectWorkforcePayments } from "./connect-workforce-payments";
import { ConnectWorkforceWork } from "./connect-workforce-work";
import { ConnectPeopleWorkspace } from "./connect-people-workspace";
import { AppAccount, ConnectProfileApp } from "./connect-profile-app";
import { countryCodeOptions } from "@/lib/country-codes";
import { requiredDropxOnePageCodes, type DropxOnePageCode } from "@/lib/dropx-one-pages";
import { userFacingError } from "@/lib/user-facing-error";
import { connectAccountKey as accountKey, connectAccountRoute, resolveConnectRouteAccount } from "@/lib/connect-account-routing";
import { connectApprovalSection } from "@/lib/connect-approval-links";
import { leaveRouteState, readConnectSessionResponse, resolveApprovalAccess, type ReporteeCheck } from "@/lib/connect-navigation-state";

type Step = "mobile" | "pin" | "otp" | "createPin" | "unlock" | "accounts" | "dashboard" | "profile" | "documents" | "connect" | "approvals" | "requests" | "payments" | "work" | "advances" | "earnings" | "reimbursements" | "attendance" | "roster" | "leave" | "lop" | "wfh" | "performance" | "settings";
const routeForStep: Partial<Record<Step, string>> = {
  accounts: "/accounts", dashboard: "/dashboard", profile: "/profile", documents: "/documents",
  connect: "/connect",
  approvals: "/approvals", requests: "/requests", payments: "/payments", work: "/work", advances: "/advances", earnings: "/earnings",
  reimbursements: "/reimbursements", attendance: "/attendance", roster: "/roster", leave: "/leave",
  wfh: "/leave/wfh", performance: "/performance", settings: "/settings"
};
function stepFromPath(pathname: string): Step | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  return (Object.entries(routeForStep).find(([, route]) => route === path)?.[0] as Step | undefined) ?? null;
}
type ConnectNotification = {
  id: string;
  title: string;
  body: string;
  route?: string | null;
  created_at: string;
  read_at?: string | null;
};
const defaultKeyName = "dropx_connect_default_account";
const biometricKey = "dropx_connect_biometric";
const credentialKey = "dropx_connect_passkey_id";
const biometricUnlockTimestampKey = "dropx_connect_last_biometric_unlock";
const biometricUnlockGracePeriodMs = 12 * 60 * 60 * 1000;
const biometricUnlockIsFresh = () => {
  const unlockedAt = Number(localStorage.getItem(biometricUnlockTimestampKey));
  return Number.isFinite(unlockedAt) && unlockedAt > 0 && Date.now() - unlockedAt < biometricUnlockGracePeriodMs;
};
const accountIdentity = (account?: AppAccount | null) =>
  [account?.reference, account?.biometricId].filter(Boolean).join(" | ");
const active = (account?: AppAccount | null) => account?.status?.toLowerCase() === "active";
const defaultPageAccess: DropxOnePageCode[] = ["dashboard", "profile", "attendance", "roster", "leave", "settings"];
const isManagerAccount = (account: AppAccount | null) => account?.profileType === "user";
const isWorkforceWorkspace = (account: AppAccount | null) => account?.workspace
  ? account.workspace === "workforce"
  : Boolean(account && !["user", "employee"].includes(account.profileType));
const peopleSelfService = (account: AppAccount | null) => Boolean(account && !isManagerAccount(account) && !isWorkforceWorkspace(account));
const sharedSelfService = (account: AppAccount | null) => Boolean(account && !isManagerAccount(account));
const allowed = (account: AppAccount | null, page: DropxOnePageCode) =>
  requiredDropxOnePageCodes.includes(page) ||
  (page === "performance" && (account?.profileType === "employee" || account?.profileType === "contractor")) ||
  (account?.pageAccess ?? defaultPageAccess).includes(page);
const showLeaveNav = (account: AppAccount | null) => Boolean(
  account &&
  active(account) &&
  (allowed(account, "leave") || account.profileType === "contractor" || allowed(account, "wfh"))
);
const showWfhInLeave = (account: AppAccount | null) => Boolean(account && active(account) && allowed(account, "wfh"));
const workforcePaymentsAvailable = (account: AppAccount | null) => Boolean(
  account && isWorkforceWorkspace(account) && ["earnings", "advances", "rate_card"].some((page) => allowed(account, page as DropxOnePageCode))
);
const workforceWorkAvailable = (account: AppAccount | null) => Boolean(
  account && isWorkforceWorkspace(account) && ["attendance", "roster", "leave"].some((page) => allowed(account, page as DropxOnePageCode))
);

function landingPage(account: AppAccount): Step {
  if (!active(account)) return "profile";
  if (isWorkforceWorkspace(account)) return "dashboard";
  if (allowed(account, "dashboard")) return "dashboard";
  if (allowed(account, "attendance")) return "attendance";
  if (allowed(account, "roster")) return "roster";
  if (showLeaveNav(account)) return "leave";
  if (allowed(account, "performance")) return "performance";
  if (allowed(account, "profile")) return "profile";
  if (allowed(account, "settings")) return "settings";
  return "accounts";
}

function Loader({ text }: { text: string }) {
  return <div className="dx-loader fullscreen"><span />{text ? <small>{text}</small> : null}</div>;
}

const ConnectCommunicationCenter = dynamic(
  () => import("./connect-communication-center").then((module) => module.ConnectCommunicationCenter),
  { loading: () => <Loader text="Opening Connect…" /> }
);

// Static fallback while the persistent workspace layout initializes.
export function ConnectShellFallback() {
  return (
    <div className="dx-app">
      <header className="dx-header">
        <button aria-hidden disabled><Menu /></button>
        <span />
        <span />
        <button aria-hidden disabled><Bell /></button>
        <span className="avatar" />
      </header>
      <div className="dx-loader fullscreen"><span /></div>
      <nav className="dx-mobile-nav" aria-hidden>
        <button disabled><Home /><span>Home</span></button>
        <button disabled><Fingerprint /><span>Attendance</span></button>
        <button disabled><ArrowLeftRight /><span>Roster</span></button>
        <button disabled><Target /><span>Performance</span></button>
      </nav>
    </div>
  );
}

export function ConnectLoginFlow() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedAccountId = searchParams.get("id")?.trim().toLowerCase() ?? "";
  const selectedAccountKey = searchParams.get("account") ?? "";
  const requestedApprovalSection = connectApprovalSection(searchParams.get("section"));
  const pendingApprovalSection = useRef(pathname === "/approvals" ? requestedApprovalSection : null);
  const [step, setStep] = useState<Step>("mobile");
  const [checking, setChecking] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [countryCode, setCountryCode] = useState("91");
  const [mobile, setMobile] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [otp, setOtp] = useState("");
  const [accounts, setAccounts] = useState<AppAccount[]>([]);
  const [account, setAccount] = useState<AppAccount | null>(null);
  const [defaultKey, setDefaultKey] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [paymentsExpanded, setPaymentsExpanded] = useState(false);
  const [profileMenu, setProfileMenu] = useState(false);
  const [notificationMenu, setNotificationMenu] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [notificationClearing, setNotificationClearing] = useState(false);
  const [notifications, setNotifications] = useState<ConnectNotification[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [avatar, setAvatar] = useState("");
  const [leaveSection, setLeaveSection] = useState<"leave" | "wfh">("leave");
  const [lockedAccounts, setLockedAccounts] = useState<AppAccount[]>([]);
  const [reporteeCheck, setReporteeCheck] = useState<ReporteeCheck | null>(null);
  const [reporteeAttempt, setReporteeAttempt] = useState(0);
  const approvalAccess = resolveApprovalAccess(account, isWorkforceWorkspace(account), reporteeCheck);
  const lastLoggedScreen = useRef("");

  // A scroll position left over from one screen (e.g. a focused input's scrollIntoView
  // during login) can otherwise carry into the next screen and render content under the
  // sticky header. Cheap and safe regardless of how panels for each step actually render.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);

  function route(rows: AppAccount[]) {
    const serverDefault = rows.find((row) => row.isDefault);
    const saved = serverDefault ? accountKey(serverDefault) : "";
    if (saved) localStorage.setItem(defaultKeyName, saved);
    else localStorage.removeItem(defaultKeyName);
    const selected = resolveConnectRouteAccount(rows, selectedAccountKey, selectedAccountId);
    setAccounts(rows); setDefaultKey(saved); setAccount(selected); setAvatar(selected?.profilePhotoUrl || "");
    const destination = selected ? (stepFromPath(pathname) ?? landingPage(selected)) : "accounts";
    if (destination === "wfh" || destination === "leave") setLeaveSection(leaveRouteState(destination).section);
    setStep(destination === "wfh" ? "leave" : destination);
  }
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    setChecking(true);
    setSessionError("");
    fetch("/api/connect/auth/session", { cache: "no-store", signal: controller.signal })
      .then((response) => readConnectSessionResponse<{
        authenticated: boolean; accounts?: AppAccount[]; countryCode?: string; mobile?: string; error?: string;
      }>(response))
      .then((payload) => {
        if (cancelled) return;
        if (payload.authenticated) {
          const rows = payload.accounts ?? [];
          setCountryCode(String(payload.countryCode || "91"));
          setMobile(String(payload.mobile || ""));
          if (localStorage.getItem(biometricKey) === "true" && localStorage.getItem(credentialKey) && !biometricUnlockIsFresh()) {
            setLockedAccounts(rows);
            setStep("unlock");
          } else route(rows);
        } else {
          setAccounts([]);
          setAccount(null);
          setStep("mobile");
          setError(payload.error || "");
        }
      })
      .catch(() => { if (!cancelled) setSessionError("Unable to load your workspace. Please retry."); })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!cancelled) setChecking(false);
      });
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
    // Load once per workspace visit, or when the user retries a failed check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionAttempt]);
  useEffect(() => {
    if ((!selectedAccountKey && !selectedAccountId) || !accounts.length) return;
    const requested = resolveConnectRouteAccount(accounts, selectedAccountKey, selectedAccountId);
    setAccount(requested);
    setAvatar(requested?.profilePhotoUrl || "");
    if (!requested) setStep("accounts");
    // Synchronize when the URL/session changes, not when choose() updates the
    // account before router.push has committed its new URL.
  }, [accounts, selectedAccountKey, selectedAccountId]);
  useEffect(() => {
    setNotificationMenu(false);
    setNotifications([]);
    setUnreadNotifications(0);
    if (account) void loadNotifications(false);
  }, [account?.id, account?.profileType]);
  useEffect(() => {
    if (!account || isWorkforceWorkspace(account) || isManagerAccount(account) || account.pageAccess?.includes("approvals")) return;
    const key = accountKey(account);
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    setReporteeCheck({ accountKey: key, status: "loading" });
    fetch(`/api/connect/approver-status?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || typeof payload?.hasReportees !== "boolean") throw new Error("Unable to check approval access.");
        if (!cancelled) setReporteeCheck({ accountKey: key, status: "ready", hasReportees: payload.hasReportees });
      })
      .catch(() => { if (!cancelled) setReporteeCheck({ accountKey: key, status: "error" }); })
      .finally(() => window.clearTimeout(timeout));
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
  }, [account?.id, account?.companyId, account?.profileType, account?.workspace, account?.pageAccess, reporteeAttempt]);
  useEffect(() => {
    if (!account || ["mobile", "pin", "otp", "createPin", "unlock", "accounts"].includes(step)) return;
    const key = `${account.profileType}:${account.id}:${step}`;
    if (lastLoggedScreen.current === key) return;
    lastLoggedScreen.current = key;
    void fetch("/api/connect/event-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: account.id,
        profileType: account.profileType,
        platform: "dropx_one_web",
        eventCode: "screen_view",
        module: "dropx_one",
        action: "view",
        route: step,
        metadata: { screen: step }
      }),
      keepalive: true
    }).catch(() => undefined);
  }, [account, step]);
  useEffect(() => {
    if (!account) return;
    const send = (eventCode: string, action: string, metadata: Record<string, string>) => {
      void fetch("/api/connect/event-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          platform: "dropx_one_web",
          eventCode,
          module: "dropx_one",
          action,
          route: step,
          metadata
        }),
        keepalive: true
      }).catch(() => undefined);
    };
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("button, a[href], [role='button']");
      if (!target) return;
      const label = String(target.getAttribute("aria-label") || target.getAttribute("title") || target.textContent || "")
        .replace(/\s+/g, " ").trim().slice(0, 80);
      if (label) send("app_action", "click", { label, screen: step });
    };
    const onSubmit = () => send("app_form_submit", "submit", { screen: step });
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, [account, step]);

  async function call(path: string, body: object) {
    setPending(true); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to continue.");
      return payload;
    } catch (reason) { setError(userFacingError(reason, "Unable to continue. Please try again.")); throw reason; }
    finally { setPending(false); }
  }
  async function start(event: FormEvent) {
    event.preventDefault();
    try {
      const payload = await call("/api/connect/auth/start", { countryCode, mobile });
      if (payload.mode === "pin") { setStep("pin"); setNotice("Enter your app PIN to continue."); }
      else {
        await call("/api/connect/auth/send-otp", { countryCode, mobile, purpose: "connect_login" });
        setStep("otp"); setNotice(`OTP sent on WhatsApp to +${countryCode} ${mobile}.`);
      }
    } catch {}
  }
  async function verifyPin(event: FormEvent) {
    event.preventDefault();
    try { const payload = await call("/api/connect/auth/verify-pin", { countryCode, mobile, pin }); route(payload.accounts ?? []); }
    catch {}
  }
  async function savePin(event: FormEvent) {
    event.preventDefault();
    if (pin !== confirmPin) { setError("PIN and re-entered PIN must match."); return; }
    try { const payload = await call("/api/connect/auth/set-pin", { countryCode, mobile, otp, pin }); route(payload.accounts ?? []); }
    catch {}
  }
  async function resetPin() {
    try {
      await call("/api/connect/auth/send-otp", { countryCode, mobile, purpose: "connect_pin_reset" });
      setOtp(""); setPin(""); setConfirmPin(""); setStep("otp"); setNotice("OTP sent. Verify it to change your PIN.");
    } catch {}
  }
  async function logout() {
    await fetch("/api/connect/auth/session", { method: "DELETE" });
    localStorage.removeItem(biometricUnlockTimestampKey);
    setCountryCode("91"); setMobile(""); setPin(""); setConfirmPin(""); setOtp("");
    setAccounts([]); setLockedAccounts([]); setAccount(null); setAvatar(""); setDrawer(false); setProfileMenu(false); setNotificationMenu(false); setNotifications([]); setUnreadNotifications(0); setStep("mobile"); setNotice("Logged out."); setError("");
  }
  async function loadNotifications(showPanel = true) {
    if (!account) return;
    if (showPanel) {
      setNotificationMenu((current) => !current);
      setProfileMenu(false);
      if (notificationMenu) return;
    }
    setNotificationLoading(true);
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/notifications?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load notifications.");
      setNotifications(payload.notifications ?? []);
      setUnreadNotifications(Number(payload.unreadCount ?? 0));
    } catch (reason) {
      setError(userFacingError(reason, "Unable to load notifications. Please try again."));
    } finally {
      setNotificationLoading(false);
    }
  }
  async function readNotification(notification: ConnectNotification) {
    if (!account) return;
    if (!notification.read_at) {
      const response = await fetch("/api/connect/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          notificationId: notification.id
        })
      });
      if (response.ok) {
        setNotifications((rows) => rows.map((row) => row.id === notification.id
          ? { ...row, read_at: new Date().toISOString() }
          : row));
        setUnreadNotifications((count) => Math.max(0, count - 1));
      }
    }
    const destination = (notification.route === "communication_center" ? "connect" : notification.route) as Step | null | undefined;
    if (destination && ["dashboard", "profile", "documents", "connect", "approvals", "requests", "advances", "earnings", "reimbursements", "attendance", "roster", "leave", "lop", "wfh", "performance", "settings"].includes(destination)) {
      setNotificationMenu(false);
      open(destination);
    } else if (destination) {
      try {
        const url = new URL(destination);
        if (url.protocol === "https:" || url.protocol === "http:") {
          setNotificationMenu(false);
          window.location.assign(url.toString());
        }
      } catch {
        // Ignore malformed notification links.
      }
    }
  }
  async function clearNotifications() {
    if (!account || !unreadNotifications || notificationClearing) return;
    setNotificationClearing(true);
    try {
      const response = await fetch("/api/connect/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          markAll: true
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to clear notifications.");
      const readAt = new Date().toISOString();
      setNotifications((rows) => rows.map((row) => row.read_at ? row : { ...row, read_at: readAt }));
      setUnreadNotifications(0);
    } catch (reason) {
      setError(userFacingError(reason, "Unable to clear notifications. Please try again."));
    } finally {
      setNotificationClearing(false);
    }
  }
  async function saveDefaultAccount(nextKey: string) {
    setPending(true); setError(""); setNotice("");
    const selected = accounts.find((row) => accountKey(row) === nextKey);
    try {
      const response = await fetch("/api/connect/preferences", {
        method: selected ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: selected ? JSON.stringify({
          accountId: selected.id,
          companyId: selected.companyId,
          profileType: selected.profileType
        }) : undefined
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to save default account.");
      setDefaultKey(nextKey);
      setAccounts((current) => current.map((row) => ({ ...row, isDefault: selected ? accountKey(row) === nextKey : false })));
      if (nextKey) localStorage.setItem(defaultKeyName, nextKey);
      else localStorage.removeItem(defaultKeyName);
      setNotice(selected ? "Default account saved." : "Default account removed.");
    } catch (reason) {
      setError(userFacingError(reason, "Unable to save default account. Please try again."));
    } finally {
      setPending(false);
    }
  }
  function bytes(value: string) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  }
  function encoded(value: ArrayBuffer) {
    return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function enrollBiometric(enabled: boolean) {
    if (!enabled) {
      localStorage.removeItem(biometricKey);
      localStorage.removeItem(credentialKey);
      localStorage.removeItem(biometricUnlockTimestampKey);
      setNotice("Biometric login disabled.");
      return;
    }
    try {
      if (!window.PublicKeyCredential) throw new Error("Face ID or passkeys are not supported on this browser.");
      const credential = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "DropX One" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: account?.reference || account?.id || "dropx-user", displayName: account?.name || "DropX user" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
        timeout: 60000
      } }) as PublicKeyCredential | null;
      if (!credential) throw new Error("Biometric setup was cancelled.");
      localStorage.setItem(credentialKey, encoded(credential.rawId));
      localStorage.setItem(biometricKey, "true");
      localStorage.setItem(biometricUnlockTimestampKey, String(Date.now()));
      setNotice("Biometric login enabled.");
    } catch (reason) {
      localStorage.removeItem(biometricKey);
      localStorage.removeItem(biometricUnlockTimestampKey);
      setError(userFacingError(reason, "Unable to enable biometric login. Please try again."));
    }
  }
  async function unlock() {
    setPending(true); setError("");
    try {
      const id = localStorage.getItem(credentialKey);
      if (!id) throw new Error("Biometric login is not configured.");
      await navigator.credentials.get({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: bytes(id), type: "public-key" }],
        userVerification: "required",
        timeout: 60000
      } });
      localStorage.setItem(biometricUnlockTimestampKey, String(Date.now()));
      route(lockedAccounts);
    } catch (reason) {
      setPin("");
      setStep("pin");
      setError(userFacingError(reason, "Biometric verification was cancelled."));
    }
    finally { setPending(false); }
  }
  function choose(next: AppAccount) {
    const destination = pendingApprovalSection.current ? "approvals" : landingPage(next);
    setAccount(next); setAvatar(next.profilePhotoUrl || ""); setDrawer(false); setStep(destination);
    router.push(urlFor(destination, next));
    pendingApprovalSection.current = null;
  }
  function urlFor(next: Step, targetAccount = account) {
    const route = routeForStep[next] ?? "/accounts";
    return connectAccountRoute(route, targetAccount, requestedApprovalSection ?? pendingApprovalSection.current);
  }
  function open(next: Step) {
    setDrawer(false); setProfileMenu(false);
    if (next === "lop") next = "leave";
    if (next === "wfh") {
      setLeaveSection("wfh");
    } else if (next === "leave") {
      setLeaveSection("leave");
    }
    if (!account) {
      setStep("accounts");
      if (pathname !== "/accounts") router.replace("/accounts");
      return;
    }
    if (!active(account) && next !== "profile" && next !== "settings") {
      setStep("profile");
      if (pathname !== "/profile") router.replace(urlFor("profile"));
      return;
    }
    const permitted =
      (next !== "dashboard" || allowed(account, "dashboard")) &&
      (next !== "attendance" || allowed(account, "attendance")) &&
      (next !== "roster" || allowed(account, "roster")) &&
      (next !== "leave" || showLeaveNav(account)) &&
      (next !== "wfh" || showWfhInLeave(account)) &&
      (next !== "performance" || allowed(account, "performance")) &&
      (next !== "profile" || allowed(account, "profile")) &&
      (next !== "settings" || allowed(account, "settings")) &&
      (next !== "documents" || (allowed(account, "documents") && sharedSelfService(account))) &&
      (next !== "requests" || peopleSelfService(account)) &&
      (next !== "approvals" || approvalAccess !== "denied") &&
      (next !== "advances" || (allowed(account, "advances") && sharedSelfService(account))) &&
      (next !== "earnings" || (allowed(account, "earnings") && isWorkforceWorkspace(account))) &&
      (next !== "payments" || workforcePaymentsAvailable(account)) &&
      (next !== "work" || workforceWorkAvailable(account)) &&
      (next !== "reimbursements" || (allowed(account, "reimbursements") && peopleSelfService(account)));
    if (!permitted) {
      const destination = landingPage(account);
      setStep(destination);
      if (pathname !== routeForStep[destination]) router.replace(urlFor(destination));
      return;
    }
    if (next === "profile" && isManagerAccount(account)) {
      setStep("settings");
      if (pathname !== "/settings") router.replace(urlFor("settings"));
      return;
    }
    setStep(next === "wfh" ? leaveRouteState(next).screen : next);
    const destination = routeForStep[next];
    if (destination && pathname !== destination) router.push(urlFor(next));
  }

  useEffect(() => {
    const requested = stepFromPath(pathname);
    const routeAccount = resolveConnectRouteAccount(accounts, selectedAccountKey, selectedAccountId);
    if ((selectedAccountKey || selectedAccountId) && (!routeAccount || !account || accountKey(routeAccount) !== accountKey(account))) return;
    if (account && requested) open(requested);
  // URL changes must always be checked through open(), which applies the
  // current designation/category master access before rendering a screen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, selectedAccountKey, selectedAccountId, account?.id, account?.companyId, account?.profileType, pathname === "/approvals" ? approvalAccess : null]);

  async function profileSubmitted() {
    const response = await fetch("/api/connect/auth/session", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.authenticated) return;
    const rows = payload.accounts ?? [];
    const refreshed = rows.find((row: AppAccount) => account && accountKey(row) === accountKey(account)) ?? null;
    setAccounts(rows);
    setAccount(refreshed);
    setAvatar(refreshed?.profilePhotoUrl || "");
    const destination = refreshed ? landingPage(refreshed) : "accounts";
    setStep(destination);
    router.replace(urlFor(destination, refreshed));
  }

  const loggedIn = ["accounts","dashboard","profile","documents","connect","approvals","requests","payments","advances","earnings","reimbursements","attendance","roster","leave","lop","wfh","performance","settings"].includes(step);
  const screenLabel: Partial<Record<Step, string>> = {
    accounts: "Accounts",
    dashboard: "Today",
    profile: "My profile",
    documents: "Documents",
    connect: "Connect",
    approvals: "Approvals",
    requests: "My requests",
    payments: "Payments",
    advances: "Pay advances",
    earnings: "My Earnings",
    reimbursements: "Expense requests",
    attendance: "Attendance",
    roster: "Roster",
    leave: "Time off",
    lop: "Time off",
    wfh: "Time off",
    performance: "Performance",
    settings: "Settings"
  };
  if (checking) return <ConnectShellFallback />;
  if (sessionError) return <div className="dx-auth"><section className="dx-auth-panel">
    <header><small>DropX One</small><h2>Workspace unavailable</h2></header>
    <p role="alert">{sessionError}</p>
    <button onClick={() => setSessionAttempt((attempt) => attempt + 1)}>Retry workspace</button>
  </section></div>;

  return <div className={`dx-app ${loggedIn ? "logged-in" : ""}`}>
    {loggedIn && account ? <aside className="dx-desktop-nav" aria-label="DropX One navigation">
      <div className="dx-desktop-brand">
        <Image alt="DropX" height={44} priority src="/dropx-logo.png" width={126} />
        <span>ONE</span>
      </div>
      <div className="dx-desktop-account">
        <i>{avatar ? <img alt="" src={avatar} /> : <b>{(account.name || "U")[0]}</b>}</i>
        <span>
          <strong>{account.name || account.reference}</strong>
          <small>{account.workspaceLabel || (isWorkforceWorkspace(account) ? "Workforce workspace" : "People workspace")} · {account.role || account.reference}</small>
        </span>
        {accounts.length > 1 ? <button aria-label="Switch accounts" onClick={() => open("accounts")}><SwitchCamera /></button> : null}
      </div>
      <nav>
        <small className="dx-nav-label">Workspace</small>
        {isWorkforceWorkspace(account) ? <>
          <button aria-current={step === "dashboard" ? "page" : undefined} className={step === "dashboard" ? "active" : ""} onClick={() => open("dashboard")}><Gauge />Home</button>
          {workforcePaymentsAvailable(account) ? <button aria-current={step === "payments" ? "page" : undefined} className={step === "payments" ? "active" : ""} onClick={() => open("payments")}><CreditCard />Payments</button> : null}
          {workforceWorkAvailable(account) ? <button aria-current={step === "work" ? "page" : undefined} className={step === "work" ? "active" : ""} onClick={() => open("work")}><CalendarDays />Work schedule</button> : null}
          {allowed(account, "performance") ? <button aria-current={step === "performance" ? "page" : undefined} className={step === "performance" ? "active" : ""} onClick={() => open("performance")}><Target />Performance</button> : null}
          {allowed(account, "connect") ? <button aria-current={step === "connect" ? "page" : undefined} className={step === "connect" ? "active" : ""} onClick={() => open("connect")}><MessageCircleMore />Connect</button> : null}
          {allowed(account, "documents") ? <button aria-current={step === "documents" ? "page" : undefined} className={step === "documents" ? "active" : ""} onClick={() => open("documents")}><Files />Documents</button> : null}
          {!isManagerAccount(account) && allowed(account, "profile") ? <button aria-current={step === "profile" ? "page" : undefined} className={step === "profile" ? "active" : ""} onClick={() => open("profile")}><UserRound />My Profile</button> : null}
        </> : <>
          {allowed(account, "dashboard") ? <button aria-current={step === "dashboard" ? "page" : undefined} className={step === "dashboard" ? "active" : ""} onClick={() => open("dashboard")}><Gauge />Dashboard</button> : null}
          {!isManagerAccount(account) && allowed(account, "profile") ? <button aria-current={step === "profile" ? "page" : undefined} className={step === "profile" ? "active" : ""} onClick={() => open("profile")}><UserRound />My Profile</button> : null}
          {peopleSelfService(account) && allowed(account, "documents") ? <button aria-current={step === "documents" ? "page" : undefined} className={step === "documents" ? "active" : ""} onClick={() => open("documents")}><Files />Documents</button> : null}
          <button aria-current={step === "connect" ? "page" : undefined} className={step === "connect" ? "active" : ""} onClick={() => open("connect")}><MessageCircleMore />Connect</button>
          {peopleSelfService(account) ? <button aria-current={step === "requests" ? "page" : undefined} className={step === "requests" ? "active" : ""} onClick={() => open("requests")}><ClipboardList />My Requests</button> : null}
          {(approvalAccess === "allowed") ? <button aria-current={step === "approvals" ? "page" : undefined} className={step === "approvals" ? "active" : ""} onClick={() => open("approvals")}><ClipboardCheck />Approval Inbox</button> : null}
          {sharedSelfService(account) && (allowed(account, "advances") || (peopleSelfService(account) && allowed(account, "reimbursements"))) ? <button aria-expanded={paymentsExpanded} className={`payments-toggle${step === "advances" || step === "reimbursements" ? " active" : ""}${paymentsExpanded ? " expanded" : ""}`} onClick={() => setPaymentsExpanded((expanded) => !expanded)}><CreditCard /><span>Payments</span><ChevronRight /></button> : null}
          {sharedSelfService(account) && allowed(account, "advances") && paymentsExpanded ? <button aria-current={step === "advances" ? "page" : undefined} className={`desktop-subitem${step === "advances" ? " active" : ""}`} onClick={() => open("advances")}><IndianRupee />Advances</button> : null}
          {peopleSelfService(account) && allowed(account, "reimbursements") && paymentsExpanded ? <button aria-current={step === "reimbursements" ? "page" : undefined} className={`desktop-subitem${step === "reimbursements" ? " active" : ""}`} onClick={() => open("reimbursements")}><ReceiptText />Expense requests</button> : null}
          {allowed(account, "attendance") ? <button aria-current={step === "attendance" ? "page" : undefined} className={step === "attendance" ? "active" : ""} onClick={() => open("attendance")}><Fingerprint />Attendance</button> : null}
          {allowed(account, "roster") ? <button aria-current={step === "roster" ? "page" : undefined} className={step === "roster" ? "active" : ""} onClick={() => open("roster")}><ArrowLeftRight />Roster</button> : null}
          {showLeaveNav(account) ? <button aria-current={step === "leave" ? "page" : undefined} className={step === "leave" ? "active" : ""} onClick={() => open("leave")}><CalendarDays />Leave</button> : null}
          {allowed(account, "performance") ? <button aria-current={step === "performance" ? "page" : undefined} className={step === "performance" ? "active" : ""} onClick={() => open("performance")}><Target />Performance</button> : null}
        </>}
        <small className="dx-nav-label">Account</small>
        {allowed(account, "settings") ? <button aria-current={step === "settings" ? "page" : undefined} className={step === "settings" ? "active" : ""} onClick={() => open("settings")}><Settings />Settings</button> : null}
      </nav>
      <button className="dx-desktop-signout" onClick={logout}><LogOut />Sign out</button>
    </aside> : null}
    {loggedIn ? <header className="dx-header">
      <button aria-label="Menu" className={!account ? "dx-menu-unavailable" : ""} disabled={!account} onClick={() => { setDrawer(true); setProfileMenu(false); }}><Menu /></button>
      <Image alt="DropX" height={42} priority src="/dropx-logo.png" width={120} />
      <span className="dx-header-context"><small>DropX One</small>{step === "dashboard" ? null : <b>{screenLabel[step] || "Workspace"}</b>}</span>
      <button aria-label="Notifications" className="dx-notification-trigger" disabled={!account} onClick={() => void loadNotifications()}><Bell />{unreadNotifications ? <b>{unreadNotifications > 99 ? "99+" : unreadNotifications}</b> : null}</button>
      <button className="avatar" onClick={() => { setProfileMenu((v) => !v); setNotificationMenu(false); setDrawer(false); }}>{avatar ? <img alt="" src={avatar} /> : <b>{(account?.name || "U")[0]}</b>}</button>
      {notificationMenu ? <aside className="dx-notification-pop">
        <header><strong>Notifications</strong><span>{unreadNotifications ? <small>{unreadNotifications} unread</small> : null}{unreadNotifications ? <button disabled={notificationClearing} onClick={() => void clearNotifications()} title="Mark all notifications as read">{notificationClearing ? <i className="mini-spin" /> : <CheckCheck />}Clear all</button> : null}</span></header>
        {notificationLoading ? <div className="dx-notification-empty"><span className="mini-spin" /></div> : notifications.length ? <div className="dx-notification-list">
          {notifications.map((item) => <button className={item.read_at ? "read" : "unread"} key={item.id} onClick={() => void readNotification(item)}>
            <i>{item.read_at ? <CheckCheck /> : <Bell />}</i>
            <span><strong>{item.title}</strong><em>{item.body}</em><small>{new Date(item.created_at).toLocaleString("en-IN")}</small></span>
          </button>)}
        </div> : <div className="dx-notification-empty"><Bell /><span>No notifications</span></div>}
      </aside> : null}
      {profileMenu ? <aside className="dx-profile-pop"><strong>{account?.name || account?.reference}</strong><small>{account?.workspaceLabel || (isWorkforceWorkspace(account) ? "Workforce workspace" : "People workspace")}</small>{accountIdentity(account) ? <small>{accountIdentity(account)}</small> : null}{!isManagerAccount(account) && allowed(account, "profile") ? <button onClick={() => open("profile")}><UserRound />My Profile</button> : null}{allowed(account, "settings") ? <button onClick={() => open("settings")}><Settings />Account settings</button> : null}<button onClick={logout}><LogOut />Sign out</button></aside> : null}
    </header> : null}
    {drawer && account ? <><button aria-label="Close menu" className="dx-scrim" onClick={() => setDrawer(false)} /><aside className="dx-drawer">
      <div><Image alt="DropX" height={44} src="/dropx-logo.png" width={126} /><button aria-label="Switch accounts" onClick={() => open("accounts")}><SwitchCamera /></button><button aria-label="Close" onClick={() => setDrawer(false)}><X /></button></div>
      <section className="dx-drawer-account">
        <i>{avatar ? <img alt="" src={avatar} /> : <b>{(account.name || "U")[0]}</b>}</i>
        <span>
          <strong>{account.name || account.reference}</strong>
          <small>{account.workspaceLabel || (isWorkforceWorkspace(account) ? "Workforce workspace" : "People workspace")} · {account.role || account.reference}</small>
        </span>
      </section>
      <nav>
        {isWorkforceWorkspace(account) ? <>
          <button onClick={() => open("dashboard")}><Gauge />Home<ChevronRight /></button>
          {workforcePaymentsAvailable(account) ? <button onClick={() => open("payments")}><CreditCard />Payments<ChevronRight /></button> : null}
          {workforceWorkAvailable(account) ? <button onClick={() => open("work")}><CalendarDays />Work schedule<ChevronRight /></button> : null}
          {allowed(account, "performance") ? <button onClick={() => open("performance")}><Target />Performance<ChevronRight /></button> : null}
          {allowed(account, "connect") ? <button onClick={() => open("connect")}><MessageCircleMore />Connect<ChevronRight /></button> : null}
          {allowed(account, "documents") ? <button onClick={() => open("documents")}><Files />Documents<ChevronRight /></button> : null}
          {!isManagerAccount(account) && allowed(account, "profile") ? <button onClick={() => open("profile")}><UserRound />My Profile<ChevronRight /></button> : null}
        </> : <>
          {allowed(account, "dashboard") ? <button onClick={() => open("dashboard")}><Gauge />Dashboard<ChevronRight /></button> : null}
          {!isManagerAccount(account) && allowed(account, "profile") ? <button onClick={() => open("profile")}><UserRound />My Profile<ChevronRight /></button> : null}
          {peopleSelfService(account) && allowed(account, "documents") ? <button onClick={() => open("documents")}><Files />Documents<ChevronRight /></button> : null}
          <button onClick={() => open("connect")}><MessageCircleMore />Connect<ChevronRight /></button>
          {peopleSelfService(account) ? <button onClick={() => open("requests")}><ClipboardList />My Requests<ChevronRight /></button> : null}
          {(approvalAccess === "allowed") ? <button onClick={() => open("approvals")}><ClipboardCheck />Approval Inbox<ChevronRight /></button> : null}
          {sharedSelfService(account) && (allowed(account, "advances") || (peopleSelfService(account) && allowed(account, "reimbursements"))) ? <button aria-expanded={paymentsExpanded} className={`payments-toggle${paymentsExpanded ? " expanded" : ""}`} onClick={() => setPaymentsExpanded((expanded) => !expanded)}><CreditCard />Payments<ChevronRight /></button> : null}
          {sharedSelfService(account) && allowed(account, "advances") && paymentsExpanded ? <button className="subitem" onClick={() => open("advances")}><span />Advances<ChevronRight /></button> : null}
          {peopleSelfService(account) && allowed(account, "reimbursements") && paymentsExpanded ? <button className="subitem" onClick={() => open("reimbursements")}><span />Expense requests<ChevronRight /></button> : null}
          {allowed(account, "attendance") ? <button onClick={() => open("attendance")}><Fingerprint />Attendance<ChevronRight /></button> : null}
          {allowed(account, "roster") ? <button onClick={() => open("roster")}><ArrowLeftRight />Roster<ChevronRight /></button> : null}
          {showLeaveNav(account) ? <button onClick={() => open("leave")}><CalendarDays />Leave<ChevronRight /></button> : null}
          {allowed(account, "performance") ? <button onClick={() => open("performance")}><Target />Performance<ChevronRight /></button> : null}
        </>}
        {allowed(account, "settings") ? <button onClick={() => open("settings")}><Settings />Settings<ChevronRight /></button> : null}
      </nav>
      <button className="signout" onClick={logout}><LogOut />Sign out</button>
    </aside></> : null}

    {!loggedIn ? <div className="dx-auth">
      <section className="dx-auth-brand">
        <span className="dx-auth-eyebrow"><Sparkles /> One workspace</span>
        <div className="dx-auth-lockup"><Image alt="DropX" height={82} priority src="/dropx-logo.png" width={232} /><b>ONE</b></div>
        <h1>Your workday.<br />Beautifully simple.</h1>
        <p>Attendance, leave, pay and profile—together in one secure place.</p>
        <div className="dx-auth-highlights">
          <span><Fingerprint /><b>Live attendance</b></span>
          <span><ShieldCheck /><b>Secure by design</b></span>
        </div>
      </section>
      <section className="dx-auth-panel">
        <header><small>DropX One</small><h2>{step === "mobile" ? "Welcome back" : step === "unlock" ? "Good to see you" : "Secure sign in"}</h2><p>{step === "mobile" ? "Continue with your registered mobile number." : "Complete this step to access your workspace."}</p></header>
        {error ? <div className="dx-alert error">{error}</div> : null}{notice ? <div className="dx-alert success">{notice}</div> : null}
        {step === "mobile" ? <form autoComplete="off" onSubmit={start}><label>Country code<select value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>{countryCodeOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select></label><label>Mobile number<input autoComplete="off" inputMode="tel" name="dropx-mobile-login" onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="Enter registered mobile number" value={mobile} /></label><button disabled={pending || mobile.length < 6}>{pending ? "Checking..." : "Continue"}</button></form> : null}
        {step === "pin" ? <form autoComplete="off" onSubmit={verifyPin}><label>App PIN<input autoComplete="new-password" inputMode="numeric" maxLength={6} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} type="password" value={pin} /></label><button disabled={pending || pin.length !== 6}>{pending ? "Signing in..." : "Sign in"}</button><button className="text" onClick={resetPin} type="button">Reset PIN</button><button className="text" onClick={() => setStep("mobile")} type="button">Change mobile number</button></form> : null}
        {step === "otp" ? <form onSubmit={(e) => { e.preventDefault(); if (otp.length === 6) setStep("createPin"); }}><label>WhatsApp OTP<input inputMode="numeric" maxLength={6} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} value={otp} /></label><button disabled={otp.length !== 6}>Continue</button></form> : null}
        {step === "createPin" ? <form onSubmit={savePin}><label>Create app PIN<input inputMode="numeric" maxLength={6} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} type="password" value={pin} /></label><label>Re-enter app PIN<input inputMode="numeric" maxLength={6} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))} type="password" value={confirmPin} /></label><button disabled={pending || pin.length !== 6}>Save PIN</button></form> : null}
        {step === "unlock" ? <form onSubmit={(e) => { e.preventDefault(); unlock(); }}><div className="dx-unlock"><Fingerprint /><strong>Unlock DropX One</strong><small>Use Face ID or your device security to continue.</small></div><button disabled={pending}>{pending ? "Unlocking..." : "Unlock"}</button><button className="text" onClick={() => { setPin(""); setStep("pin"); }} type="button">Use PIN</button></form> : null}
        <footer><ShieldCheck /><span>Protected workspace access</span></footer>
        <ConnectAppInstallCard />
      </section>
    </div> : <main className="dx-content" data-screen={step} key={account ? accountKey(account) : "accounts"}>
      {notice ? <div className="dx-alert success">{notice}<button onClick={() => setNotice("")}><X /></button></div> : null}
      {error ? <div className="dx-alert error">{error}<button onClick={() => setError("")}><X /></button></div> : null}
      {step === "accounts" ? <section className="dx-accounts">{accounts.map((row) => <button className={isWorkforceWorkspace(row) ? "workforce" : "people"} key={accountKey(row)} onClick={() => choose(row)}><i>{row.profilePhotoUrl ? <img alt="" src={row.profilePhotoUrl} /> : <UsersRound />}</i><span><strong>{row.name || row.reference}</strong><em>{row.role || "-"}</em><small>{row.companyName || "-"}{row.reference ? ` · ${row.reference}` : ""}</small></span><ChevronRight /></button>)}</section> : null}
      {account && active(account) && allowed(account, "attendance") ? (
        <AttendanceLocationMonitor account={account} />
      ) : null}
      {account ? <ConnectNativeBridge account={account} /> : null}
      {step === "dashboard" && account && isManagerAccount(account) ? <ConnectPeopleWorkspace account={account} onApprovals={() => open("approvals")} onSettings={() => open("settings")} onSwitch={() => open("accounts")} /> : null}
      {step === "dashboard" && account && !isManagerAccount(account) ? <ConnectDashboard account={account} onAdvances={() => open("advances")} onAttendance={() => open("attendance")} onConnect={() => open("connect")} onLeave={() => open("leave")} onPayments={() => open("payments")} onPerformance={() => open("performance")} onProfile={() => open("profile")} onRoster={() => open("roster")} onWork={() => open("work")} variant={isWorkforceWorkspace(account) ? "workforce" : "people"} /> : null}
      {step === "profile" && account && !isManagerAccount(account) && (allowed(account, "profile") || !active(account)) ? <ConnectProfileApp account={account} onPhoto={(url) => setAvatar(url)} onSubmitted={profileSubmitted} /> : null}
      {step === "documents" && account && sharedSelfService(account) && allowed(account, "documents") ? <ConnectDocuments account={account} /> : null}
      {step === "connect" && account && isWorkforceWorkspace(account) ? <ConnectCommunicationCenter account={account} /> : null}
      {step === "connect" && account && !isWorkforceWorkspace(account) ? <ConnectCommunicationCenter account={account} /> : null}
      {step === "requests" && account && peopleSelfService(account) ? <ConnectMyRequests account={account} /> : null}
      {step === "approvals" && account && approvalAccess === "allowed" ? <ConnectApprovalInbox account={account} initialSection={requestedApprovalSection} /> : null}
      {step === "approvals" && account && approvalAccess === "loading" ? <div role="status"><Loader text="Checking approval access..." /></div> : null}
      {step === "approvals" && account && approvalAccess === "error" ? <section className="dx-setting-card">
        <div role="alert">Unable to check approval access. Please retry.</div>
        <button onClick={() => setReporteeAttempt((attempt) => attempt + 1)}>Retry approval access</button>
      </section> : null}
      {step === "advances" && account && sharedSelfService(account) && allowed(account, "advances") ? <ConnectAdvances account={account} /> : null}
      {step === "payments" && account && workforcePaymentsAvailable(account) ? <ConnectWorkforcePayments account={account} /> : null}
      {step === "work" && account && workforceWorkAvailable(account) ? <ConnectWorkforceWork account={account} /> : null}
      {step === "reimbursements" && account && peopleSelfService(account) && allowed(account, "reimbursements") ? <ConnectReimbursements account={account} /> : null}
      {step === "attendance" && account && allowed(account, "attendance") ? <ConnectAttendance account={account} /> : null}
      {step === "roster" && account && allowed(account, "roster") ? <ConnectRoster account={account} /> : null}
      {step === "leave" && account && showLeaveNav(account) ? <ConnectLeave account={account} initialSection={leaveSection} /> : null}
      {step === "lop" && account && showLeaveNav(account) ? <ConnectLeave account={account} initialSection={leaveSection} /> : null}
      {step === "performance" && account && allowed(account, "performance") ? <ConnectPerformance account={account} /> : null}
      {step === "settings" && account && allowed(account, "settings") ? <section className="dx-settings">
        <header className="dx-page-intro"><small>Personalisation</small><h1>Settings</h1><p>Control sign-in and the account you open first.</p></header>
        <div className="dx-settings-grid">
          <section className="dx-setting-card"><i><SwitchCamera /></i><span><strong>Default account</strong><small>Choose the workspace shown after sign in.</small></span><label><span className="sr-only">Default account</span><select disabled={pending} value={defaultKey} onChange={(e) => saveDefaultAccount(e.target.value)}><option value="">Ask me every time</option>{accounts.map((row) => <option key={accountKey(row)} value={accountKey(row)}>{row.role || row.profileType} · {row.workspaceLabel || (isWorkforceWorkspace(row) ? "Workforce workspace" : "People workspace")} · {row.companyName} - {row.reference || row.name}</option>)}</select></label></section>
          <section className="dx-setting-card"><i><Fingerprint /></i><span><strong>Biometric login</strong><small>Use Face ID or device security once every 12 hours on this device.</small></span><label className="toggle"><span>Enable biometric login</span><input aria-label="Enable biometric login" defaultChecked={localStorage.getItem(biometricKey) === "true"} onChange={(e) => enrollBiometric(e.target.checked)} type="checkbox" /></label></section>
          <section className="dx-setting-card security"><i><LockKeyhole /></i><span><strong>App PIN</strong><small>Change your six-digit sign-in PIN securely.</small></span><button onClick={resetPin}>Change PIN <ChevronRight /></button></section>
        </div>
      </section> : null}
    </main>}
    {loggedIn && account ? <nav aria-label="Primary navigation" className="dx-mobile-nav">
      {isWorkforceWorkspace(account) ? <>
        <button aria-current={step === "dashboard" ? "page" : undefined} className={step === "dashboard" ? "active" : ""} onClick={() => open("dashboard")}><Home /><span>Home</span></button>
        {workforcePaymentsAvailable(account) ? <button aria-current={step === "payments" ? "page" : undefined} className={step === "payments" ? "active" : ""} onClick={() => open("payments")}><IndianRupee /><span>Payments</span></button> : null}
        {workforceWorkAvailable(account) ? <button aria-current={step === "work" ? "page" : undefined} className={step === "work" ? "active" : ""} onClick={() => open("work")}><CalendarDays /><span>Work</span></button> : null}
        {allowed(account, "connect") ? <button aria-current={step === "connect" ? "page" : undefined} className={step === "connect" ? "active" : ""} onClick={() => open("connect")}><MessageCircleMore /><span>Connect</span></button> : null}
        {allowed(account, "performance") ? <button aria-current={step === "performance" ? "page" : undefined} className={step === "performance" ? "active" : ""} onClick={() => open("performance")}><Target /><span>Performance</span></button> : null}
      </> : <>
        {allowed(account, "dashboard") ? <button aria-current={step === "dashboard" ? "page" : undefined} className={step === "dashboard" ? "active" : ""} onClick={() => open("dashboard")}><Home /><span>Home</span></button> : null}
        {allowed(account, "attendance") ? <button aria-current={step === "attendance" ? "page" : undefined} className={step === "attendance" ? "active" : ""} onClick={() => open("attendance")}><Fingerprint /><span>Attendance</span></button> : null}
        {allowed(account, "roster") ? <button aria-current={step === "roster" ? "page" : undefined} className={step === "roster" ? "active" : ""} onClick={() => open("roster")}><ArrowLeftRight /><span>Roster</span></button> : null}
        <button aria-current={step === "connect" ? "page" : undefined} className={step === "connect" ? "active" : ""} onClick={() => open("connect")}><MessageCircleMore /><span>Connect</span></button>
        {allowed(account, "performance") ? <button aria-current={step === "performance" ? "page" : undefined} className={step === "performance" ? "active" : ""} onClick={() => open("performance")}><Target /><span>Performance</span></button> : null}
      </>}
    </nav> : null}
  </div>;
}

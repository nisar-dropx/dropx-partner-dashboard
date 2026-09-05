"use client";

import Image from "next/image";
import { ArrowLeftRight, Bell, CalendarDays, CheckCheck, ChevronRight, ClipboardCheck, ClipboardList, CreditCard, Files, Fingerprint, Gauge, Home, IndianRupee, LockKeyhole, LogOut, Menu, ReceiptText, Settings, ShieldCheck, Sparkles, SwitchCamera, Target, UserRound, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConnectAttendance } from "./connect-attendance";
import { AttendanceLocationMonitor } from "./attendance-location-monitor";
import { ConnectNativeBridge } from "./connect-native-bridge";
import { ConnectDashboard } from "./connect-dashboard";
import { ConnectDocuments } from "./connect-documents";
import { ConnectLeave } from "./connect-leave";
import { ConnectRoster } from "./connect-roster";
import { ConnectAdvances } from "./connect-advances";
import { ConnectPerformance } from "./connect-performance";
import { ConnectReimbursements } from "./connect-reimbursements";
import { ConnectApprovalInbox } from "./connect-approval-inbox";
import { ConnectMyRequests } from "./connect-my-requests";
import { ConnectPeopleWorkspace } from "./connect-people-workspace";
import { AppAccount, ConnectProfileApp } from "./connect-profile-app";
import { countryCodeOptions } from "@/lib/country-codes";
import { requiredDropxOnePageCodes, type DropxOnePageCode } from "@/lib/dropx-one-pages";
import { userFacingError } from "@/lib/user-facing-error";

type Step = "mobile" | "pin" | "otp" | "createPin" | "unlock" | "accounts" | "dashboard" | "profile" | "documents" | "approvals" | "requests" | "payments" | "advances" | "reimbursements" | "attendance" | "roster" | "leave" | "lop" | "wfh" | "performance" | "settings";
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
const accountKey = (account: AppAccount) => `${account.profileType}:${account.companyId}:${account.id}`;
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
const canViewApprovals = (account: AppAccount | null, hasReportees: boolean) => Boolean(
  account &&
  !isWorkforceWorkspace(account) &&
  (isManagerAccount(account) || hasReportees || (account.pageAccess?.includes("approvals") ?? false))
);
const showLeaveNav = (account: AppAccount | null) => Boolean(
  account &&
  active(account) &&
  (allowed(account, "leave") || account.profileType === "contractor" || allowed(account, "wfh"))
);
const showWfhInLeave = (account: AppAccount | null) => Boolean(account && active(account) && allowed(account, "wfh"));

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

export function ConnectLoginFlow() {
  const [step, setStep] = useState<Step>("mobile");
  const [checking, setChecking] = useState(true);
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
  const [hasReportees, setHasReportees] = useState(false);
  const lastLoggedScreen = useRef("");

  function route(rows: AppAccount[]) {
    const serverDefault = rows.find((row) => row.isDefault);
    const saved = serverDefault ? accountKey(serverDefault) : "";
    if (saved) localStorage.setItem(defaultKeyName, saved);
    else localStorage.removeItem(defaultKeyName);
    const selected = serverDefault ?? (rows.length === 1 ? rows[0] : null);
    setAccounts(rows); setDefaultKey(saved); setAccount(selected); setAvatar(selected?.profilePhotoUrl || "");
    setStep(selected ? landingPage(selected) : "accounts");
  }
  useEffect(() => {
    fetch("/api/connect/auth/session").then((r) => r.json()).then((payload) => {
      if (payload.authenticated) {
        const rows = payload.accounts ?? [];
        setCountryCode(String(payload.countryCode || "91"));
        setMobile(String(payload.mobile || ""));
        if (localStorage.getItem(biometricKey) === "true" && localStorage.getItem(credentialKey)) {
          setLockedAccounts(rows);
          setStep("unlock");
        } else route(rows);
      }
    }).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    const onPop = () => {
      if (account && step !== landingPage(account)) setStep(landingPage(account));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [account, step]);
  useEffect(() => {
    setNotificationMenu(false);
    setNotifications([]);
    setUnreadNotifications(0);
    if (account) void loadNotifications(false);
  }, [account?.id, account?.profileType]);
  useEffect(() => {
    setHasReportees(false);
    if (!account || isWorkforceWorkspace(account)) return;
    let cancelled = false;
    fetch(`/api/connect/approver-status?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`)
      .then((response) => response.json())
      .then((payload) => { if (!cancelled) setHasReportees(Boolean(payload?.hasReportees)); })
      .catch(() => { if (!cancelled) setHasReportees(false); });
    return () => { cancelled = true; };
  }, [account?.id, account?.profileType]);
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
    const destination = notification.route as Step | null | undefined;
    if (destination && ["dashboard", "profile", "documents", "approvals", "requests", "advances", "reimbursements", "attendance", "roster", "leave", "lop", "wfh", "performance", "settings"].includes(destination)) {
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
      setNotice("Biometric login enabled.");
    } catch (reason) {
      localStorage.removeItem(biometricKey);
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
      route(lockedAccounts);
    } catch (reason) {
      setPin("");
      setStep("pin");
      setError(userFacingError(reason, "Biometric verification was cancelled."));
    }
    finally { setPending(false); }
  }
  function choose(next: AppAccount) {
    setAccount(next); setAvatar(next.profilePhotoUrl || ""); setDrawer(false); setStep(landingPage(next));
  }
  function open(next: Step) {
    setDrawer(false); setProfileMenu(false);
    if (next === "lop") next = "leave";
    if (next === "wfh") {
      if (!account || !showWfhInLeave(account)) return;
      setLeaveSection("wfh");
      next = "leave";
    } else if (next === "leave") {
      setLeaveSection("leave");
    }
    if (!account) {
      setStep("accounts");
      return;
    }
    if (!active(account) && next !== "profile" && next !== "settings") {
      setStep("profile");
      return;
    }
    if (next === "dashboard" && !allowed(account, "dashboard")) return;
    if (next === "attendance" && !allowed(account, "attendance")) return;
    if (next === "roster" && !allowed(account, "roster")) return;
    if (next === "leave" && !showLeaveNav(account)) return;
    if (next === "performance" && !allowed(account, "performance")) return;
    if (next === "profile" && !allowed(account, "profile")) return;
    if (next === "settings" && !allowed(account, "settings")) return;
    if (next === "documents" && (!allowed(account, "documents") || !peopleSelfService(account))) return;
    if (next === "requests" && !peopleSelfService(account)) return;
    if (next === "approvals" && !canViewApprovals(account, hasReportees)) return;
    if (next === "advances" && (!allowed(account, "advances") || !sharedSelfService(account))) return;
    if (next === "reimbursements" && (!allowed(account, "reimbursements") || !peopleSelfService(account))) return;
    if (next === "profile" && isManagerAccount(account)) {
      setStep("settings");
      return;
    }
    setStep(next);
  }

  async function profileSubmitted() {
    const response = await fetch("/api/connect/auth/session", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.authenticated) return;
    const rows = payload.accounts ?? [];
    const refreshed = rows.find((row: AppAccount) => account && accountKey(row) === accountKey(account)) ?? null;
    setAccounts(rows);
    setAccount(refreshed);
    setAvatar(refreshed?.profilePhotoUrl || "");
    setStep(refreshed ? landingPage(refreshed) : "accounts");
  }

  const loggedIn = ["accounts","dashboard","profile","documents","approvals","requests","payments","advances","reimbursements","attendance","roster","leave","lop","wfh","performance","settings"].includes(step);
  const screenLabel: Partial<Record<Step, string>> = {
    accounts: "Accounts",
    dashboard: "Today",
    profile: "My profile",
    documents: "Documents",
    approvals: "Approvals",
    requests: "My requests",
    payments: "Payments",
    advances: "Pay advances",
    reimbursements: "Reimbursements",
    attendance: "Attendance",
    roster: "Roster",
    leave: "Time off",
    lop: "Time off",
    wfh: "Time off",
    performance: "Performance",
    settings: "Settings"
  };
  if (checking) return <div className="dx-auth"><Loader text="" /></div>;

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
        {allowed(account, "dashboard") ? <button aria-current={step === "dashboard" ? "page" : undefined} className={step === "dashboard" ? "active" : ""} onClick={() => open("dashboard")}><Gauge />Dashboard</button> : null}
        {!isManagerAccount(account) && allowed(account, "profile") ? <button aria-current={step === "profile" ? "page" : undefined} className={step === "profile" ? "active" : ""} onClick={() => open("profile")}><UserRound />My Profile</button> : null}
        {peopleSelfService(account) && allowed(account, "documents") ? <button aria-current={step === "documents" ? "page" : undefined} className={step === "documents" ? "active" : ""} onClick={() => open("documents")}><Files />Documents</button> : null}
        {peopleSelfService(account) ? <button aria-current={step === "requests" ? "page" : undefined} className={step === "requests" ? "active" : ""} onClick={() => open("requests")}><ClipboardList />My Requests</button> : null}
        {canViewApprovals(account, hasReportees) ? <button aria-current={step === "approvals" ? "page" : undefined} className={step === "approvals" ? "active" : ""} onClick={() => open("approvals")}><ClipboardCheck />Approval Inbox</button> : null}
        {sharedSelfService(account) && (allowed(account, "advances") || (peopleSelfService(account) && allowed(account, "reimbursements"))) ? <button aria-expanded={paymentsExpanded} className={`payments-toggle${step === "advances" || step === "reimbursements" ? " active" : ""}${paymentsExpanded ? " expanded" : ""}`} onClick={() => setPaymentsExpanded((expanded) => !expanded)}><CreditCard /><span>Payments</span><ChevronRight /></button> : null}
        {sharedSelfService(account) && allowed(account, "advances") && paymentsExpanded ? <button aria-current={step === "advances" ? "page" : undefined} className={`desktop-subitem${step === "advances" ? " active" : ""}`} onClick={() => open("advances")}><IndianRupee />Advances</button> : null}
        {peopleSelfService(account) && allowed(account, "reimbursements") && paymentsExpanded ? <button aria-current={step === "reimbursements" ? "page" : undefined} className={`desktop-subitem${step === "reimbursements" ? " active" : ""}`} onClick={() => open("reimbursements")}><ReceiptText />Reimbursements</button> : null}
        {allowed(account, "attendance") ? <button aria-current={step === "attendance" ? "page" : undefined} className={step === "attendance" ? "active" : ""} onClick={() => open("attendance")}><Fingerprint />Attendance</button> : null}
        {allowed(account, "roster") ? <button aria-current={step === "roster" ? "page" : undefined} className={step === "roster" ? "active" : ""} onClick={() => open("roster")}><ArrowLeftRight />Roster</button> : null}
        {showLeaveNav(account) ? <button aria-current={step === "leave" ? "page" : undefined} className={step === "leave" ? "active" : ""} onClick={() => open("leave")}><CalendarDays />Leave</button> : null}
        {allowed(account, "performance") ? <button aria-current={step === "performance" ? "page" : undefined} className={step === "performance" ? "active" : ""} onClick={() => open("performance")}><Target />Performance</button> : null}
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
        {allowed(account, "dashboard") ? <button onClick={() => open("dashboard")}><Gauge />Dashboard<ChevronRight /></button> : null}
        {!isManagerAccount(account) && allowed(account, "profile") ? <button onClick={() => open("profile")}><UserRound />My Profile<ChevronRight /></button> : null}
        {peopleSelfService(account) && allowed(account, "documents") ? <button onClick={() => open("documents")}><Files />Documents<ChevronRight /></button> : null}
        {peopleSelfService(account) ? <button onClick={() => open("requests")}><ClipboardList />My Requests<ChevronRight /></button> : null}
        {canViewApprovals(account, hasReportees) ? <button onClick={() => open("approvals")}><ClipboardCheck />Approval Inbox<ChevronRight /></button> : null}
        {sharedSelfService(account) && (allowed(account, "advances") || (peopleSelfService(account) && allowed(account, "reimbursements"))) ? <button aria-expanded={paymentsExpanded} className={`payments-toggle${paymentsExpanded ? " expanded" : ""}`} onClick={() => setPaymentsExpanded((expanded) => !expanded)}><CreditCard />Payments<ChevronRight /></button> : null}
        {sharedSelfService(account) && allowed(account, "advances") && paymentsExpanded ? <button className="subitem" onClick={() => open("advances")}><span />Advances<ChevronRight /></button> : null}
        {peopleSelfService(account) && allowed(account, "reimbursements") && paymentsExpanded ? <button className="subitem" onClick={() => open("reimbursements")}><span />Reimbursements<ChevronRight /></button> : null}
        {allowed(account, "attendance") ? <button onClick={() => open("attendance")}><Fingerprint />Attendance<ChevronRight /></button> : null}
        {allowed(account, "roster") ? <button onClick={() => open("roster")}><ArrowLeftRight />Roster<ChevronRight /></button> : null}
        {showLeaveNav(account) ? <button onClick={() => open("leave")}><CalendarDays />Leave<ChevronRight /></button> : null}
        {allowed(account, "performance") ? <button onClick={() => open("performance")}><Target />Performance<ChevronRight /></button> : null}
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
      </section>
    </div> : <main className="dx-content" data-screen={step}>
      {notice ? <div className="dx-alert success">{notice}<button onClick={() => setNotice("")}><X /></button></div> : null}
      {error ? <div className="dx-alert error">{error}<button onClick={() => setError("")}><X /></button></div> : null}
      {step === "accounts" ? <section className="dx-accounts"><header className="dx-page-intro"><small>Account switcher</small><h1>Choose workspace</h1><p>Use the role you need now. Each workspace keeps its own access and tools.</p></header>{accounts.map((row) => <button className={isWorkforceWorkspace(row) ? "workforce" : "people"} key={accountKey(row)} onClick={() => choose(row)}><i>{row.profilePhotoUrl ? <img alt="" src={row.profilePhotoUrl} /> : <UsersRound />}</i><span><b>{row.workspaceLabel || (isWorkforceWorkspace(row) ? "Workforce workspace" : "People workspace")}</b><strong>{row.name || row.reference}</strong><em>{row.role || row.companyName}</em><small>{row.companyName}{row.reference ? ` · ${row.reference}` : ""}</small></span><ChevronRight /></button>)}</section> : null}
      {account && active(account) && allowed(account, "attendance") ? (
        <AttendanceLocationMonitor account={account} />
      ) : null}
      {account ? <ConnectNativeBridge account={account} /> : null}
      {step === "dashboard" && account && isManagerAccount(account) ? <ConnectPeopleWorkspace account={account} onApprovals={() => open("approvals")} onSettings={() => open("settings")} onSwitch={() => open("accounts")} /> : null}
      {step === "dashboard" && account && !isManagerAccount(account) ? <ConnectDashboard account={account} onAdvances={() => open("advances")} onAttendance={() => open("attendance")} onLeave={() => open("leave")} onPerformance={() => open("performance")} onProfile={() => open("profile")} onRoster={() => open("roster")} variant={isWorkforceWorkspace(account) ? "workforce" : "people"} /> : null}
      {step === "profile" && account && !isManagerAccount(account) && (allowed(account, "profile") || !active(account)) ? <ConnectProfileApp account={account} onPhoto={(url) => setAvatar(url)} onSubmitted={profileSubmitted} /> : null}
      {step === "documents" && account && peopleSelfService(account) && allowed(account, "documents") ? <ConnectDocuments account={account} /> : null}
      {step === "requests" && account && peopleSelfService(account) ? <ConnectMyRequests account={account} /> : null}
      {step === "approvals" && account && canViewApprovals(account, hasReportees) ? <ConnectApprovalInbox account={account} /> : null}
      {step === "advances" && account && sharedSelfService(account) && allowed(account, "advances") ? <ConnectAdvances account={account} /> : null}
      {step === "reimbursements" && account && peopleSelfService(account) && allowed(account, "reimbursements") ? <ConnectReimbursements account={account} /> : null}
      {step === "attendance" && account && allowed(account, "attendance") ? <ConnectAttendance account={account} /> : null}
      {step === "roster" && account && allowed(account, "roster") ? <ConnectRoster account={account} /> : null}
      {step === "leave" && account && showLeaveNav(account) ? <ConnectLeave account={account} initialSection={leaveSection} /> : null}
      {step === "lop" && account && showLeaveNav(account) ? <ConnectLeave account={account} initialSection={leaveSection} /> : null}
      {step === "performance" && account && allowed(account, "performance") ? <ConnectPerformance account={account} /> : null}
      {step === "settings" && account && allowed(account, "settings") ? <section className="dx-settings">
        <header className="dx-page-intro"><small>Personalisation</small><h1>Settings</h1><p>Control sign-in and the account you open first.</p></header>
        <div className="dx-settings-grid">
          <section className="dx-setting-card"><i><SwitchCamera /></i><span><strong>Default account</strong><small>Choose the workspace shown after sign in.</small></span><label><span className="sr-only">Default account</span><select disabled={pending} value={defaultKey} onChange={(e) => saveDefaultAccount(e.target.value)}><option value="">Ask me every time</option>{accounts.map((row) => <option key={accountKey(row)} value={accountKey(row)}>{row.companyName} - {row.reference || row.name}</option>)}</select></label></section>
          <section className="dx-setting-card"><i><Fingerprint /></i><span><strong>Biometric login</strong><small>Use Face ID or device security on this device.</small></span><label className="toggle"><span>Enable biometric login</span><input aria-label="Enable biometric login" defaultChecked={localStorage.getItem(biometricKey) === "true"} onChange={(e) => enrollBiometric(e.target.checked)} type="checkbox" /></label></section>
          <section className="dx-setting-card security"><i><LockKeyhole /></i><span><strong>App PIN</strong><small>Change your six-digit sign-in PIN securely.</small></span><button onClick={resetPin}>Change PIN <ChevronRight /></button></section>
        </div>
      </section> : null}
    </main>}
    {loggedIn && account ? <nav aria-label="Primary navigation" className="dx-mobile-nav">
      {allowed(account, "dashboard") ? <button aria-current={step === "dashboard" ? "page" : undefined} className={step === "dashboard" ? "active" : ""} onClick={() => open("dashboard")}><Home /><span>Home</span></button> : null}
      {isWorkforceWorkspace(account) && allowed(account, "advances") ? <button aria-current={step === "advances" ? "page" : undefined} className={step === "advances" ? "active" : ""} onClick={() => open("advances")}><IndianRupee /><span>Advances</span></button> : null}
      {allowed(account, "attendance") ? <button aria-current={step === "attendance" ? "page" : undefined} className={step === "attendance" ? "active" : ""} onClick={() => open("attendance")}><Fingerprint /><span>Attendance</span></button> : null}
      {allowed(account, "roster") ? <button aria-current={step === "roster" ? "page" : undefined} className={step === "roster" ? "active" : ""} onClick={() => open("roster")}><ArrowLeftRight /><span>Roster</span></button> : null}
      {allowed(account, "performance") ? <button aria-current={step === "performance" ? "page" : undefined} className={step === "performance" ? "active" : ""} onClick={() => open("performance")}><Target /><span>Performance</span></button> : null}
    </nav> : null}
  </div>;
}

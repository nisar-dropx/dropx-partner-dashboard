"use client";

import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import { ConnectProfileCompletion } from "./connect-profile-completion";
import { ConnectExitManagement } from "./connect-exit-management";
import { countryCodeOptions } from "@/lib/country-codes";

type Step = "mobile" | "pin" | "otp" | "createPin" | "account" | "profile" | "exit" | "home" | "settings";

type ConnectAccount = {
  id: string;
  companyId: string;
  profileType: string;
  name: string | null;
  email: string | null;
  reference: string | null;
  role: string | null;
  status?: string | null;
  companyName: string;
  label: string;
};

const defaultAccountStorageKey = "dropx_connect_default_account";

function accountStorageKey(account: ConnectAccount) {
  return `${account.profileType}:${account.companyId}:${account.id}`;
}

function findDefaultAccount(accountList: ConnectAccount[], defaultKey: string | null) {
  if (!defaultKey) return null;
  return accountList.find((account) => accountStorageKey(account) === defaultKey) ?? null;
}

function accountInitial(account: ConnectAccount | null) {
  const text = account?.name || account?.reference || account?.email || "U";
  return text.trim().charAt(0).toUpperCase() || "U";
}

export function ConnectLoginFlow() {
  const [step, setStep] = useState<Step>("mobile");
  const [countryCode, setCountryCode] = useState("91");
  const [mobile, setMobile] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [otp, setOtp] = useState("");
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<ConnectAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<ConnectAccount | null>(null);
  const [defaultAccountKey, setDefaultAccountKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  function routeAfterAuth(accountList: ConnectAccount[], noticeText: string) {
    const storedDefault = typeof window === "undefined" ? null : window.localStorage.getItem(defaultAccountStorageKey);
    setDefaultAccountKey(storedDefault);
    const defaultAccount = findDefaultAccount(accountList, storedDefault);
    if (defaultAccount) {
      setSelectedAccount(defaultAccount);
      setStep(defaultAccount.profileType === "employee" ? "profile" : "home");
      setNotice(noticeText);
      return;
    }
    setSelectedAccount(null);
    setStep("account");
    setNotice(noticeText);
  }

  function saveDefaultAccount(key: string) {
    setDefaultAccountKey(key);
    window.localStorage.setItem(defaultAccountStorageKey, key);
  }

  useEffect(() => {
    let isMounted = true;
    fetch("/api/connect/auth/session")
      .then((response) => response.json())
      .then((payload: { authenticated?: boolean; accounts?: ConnectAccount[] }) => {
        if (!isMounted || !payload.authenticated) return;
        const sessionAccounts = payload.accounts ?? [];
        setAccounts(sessionAccounts);
        routeAfterAuth(sessionAccounts, "");
      })
      .catch(() => undefined)
      .finally(() => {
        if (isMounted) setCheckingSession(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  function mobileNoticeNumber() {
    const digits = mobile.replace(/\D/g, "");
    return `+${countryCode} ${digits}`;
  }

  async function sendOtp(purpose: "connect_login" | "connect_pin_reset") {
    const response = await fetch("/api/connect/auth/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobile, countryCode, purpose })
    });
    const payload = await response.json() as { error?: string; expiresInMinutes?: number };
    if (!response.ok) throw new Error(payload.error || "Unable to send OTP.");
    setExpiresInMinutes(payload.expiresInMinutes ?? null);
    return payload;
  }

  async function checkMobile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const response = await fetch("/api/connect/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile, countryCode })
      });
      const payload = await response.json() as { error?: string; mode?: "pin" | "setup"; accounts?: ConnectAccount[] };
      if (!response.ok) throw new Error(payload.error || "Unable to check mobile number.");
      setAccounts(payload.accounts ?? []);
      if (payload.mode === "pin") {
        setStep("pin");
        setNotice("Enter your app PIN to continue.");
      } else {
        await sendOtp("connect_login");
        setStep("otp");
        setNotice(`OTP sent on WhatsApp to ${mobileNoticeNumber()}.`);
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to continue.");
    } finally {
      setPending(false);
    }
  }

  async function verifyPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const response = await fetch("/api/connect/auth/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile, countryCode, pin })
      });
      const payload = await response.json() as { error?: string; accounts?: ConnectAccount[] };
      if (!response.ok) throw new Error(payload.error || "Unable to verify PIN.");
      const verifiedAccounts = payload.accounts ?? [];
      setAccounts(verifiedAccounts);
      routeAfterAuth(verifiedAccounts, "Signed in.");
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : "Unable to verify PIN.");
    } finally {
      setPending(false);
    }
  }

  function submitOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (otp.length !== 6) {
      setError("Enter the 6 digit OTP.");
      return;
    }
    setStep("createPin");
    setNotice("Create your 6 digit app PIN.");
  }

  async function createPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (pin !== confirmPin) {
      setError("PIN and re-entered PIN must match.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/connect/auth/set-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile, countryCode, otp, pin })
      });
      const payload = await response.json() as { error?: string; accounts?: ConnectAccount[] };
      if (!response.ok) throw new Error(payload.error || "Unable to create PIN.");
      const createdAccounts = payload.accounts ?? [];
      setAccounts(createdAccounts);
      routeAfterAuth(createdAccounts, "PIN created and signed in.");
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : "Unable to create PIN.");
    } finally {
      setPending(false);
    }
  }

  async function resetPin() {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await sendOtp("connect_pin_reset");
      setOtp("");
      setPin("");
      setConfirmPin("");
      setStep("otp");
      setNotice(`Reset OTP sent on WhatsApp to ${mobileNoticeNumber()}.`);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Unable to reset PIN.");
    } finally {
      setPending(false);
    }
  }

  async function logout() {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await fetch("/api/connect/auth/session", { method: "DELETE" });
    } finally {
      setAccounts([]);
      setSelectedAccount(null);
      setMenuOpen(false);
      setProfileMenuOpen(false);
      setMobile("");
      setPin("");
      setConfirmPin("");
      setOtp("");
      setStep("mobile");
      setNotice("Logged out. Enter mobile number to continue.");
      setPending(false);
    }
  }

  function selectAccount(account: ConnectAccount) {
    setSelectedAccount(account);
    setError(null);
    setNotice(null);
    setMenuOpen(false);
    setProfileMenuOpen(false);
    setStep(account.profileType === "employee" ? "profile" : "home");
  }

  const isLoggedInView = step === "account" || step === "profile" || step === "exit" || step === "home" || step === "settings";
  const activeAccount = selectedAccount ?? findDefaultAccount(accounts, defaultAccountKey);

  return (
    <div className="connect-login-stack">
      {!isLoggedInView ? (
        <div className="connect-brand">
          <Image alt="DropX" height={54} priority src="/dropx-logo.png" width={154} />
          <div>
            <p>DropX Connect</p>
            <h1>Sign in with your mobile number</h1>
          </div>
        </div>
      ) : (
        <header className="connect-app-header">
          <button aria-label="Open menu" className="connect-header-icon" onClick={() => { setMenuOpen((open) => !open); setProfileMenuOpen(false); }} type="button">
            <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 24 24" width="22">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
            </svg>
          </button>
          <Image alt="DropX" className="connect-header-logo" height={36} priority src="/dropx-logo.png" width={102} />
          <div className="connect-header-actions">
            <button aria-label="Profile menu" className="connect-profile-chip" onClick={() => { setProfileMenuOpen((open) => !open); setMenuOpen(false); }} type="button">
              <span className="connect-avatar">{accountInitial(activeAccount)}</span>
            </button>
          </div>
          {menuOpen ? (
            <section className="connect-header-menu connect-main-menu">
              {activeAccount?.profileType === "employee" ? <button onClick={() => { setSelectedAccount(activeAccount); setStep("exit"); setMenuOpen(false); setProfileMenuOpen(false); }} type="button">Exit management</button> : null}
              <button onClick={() => { setStep("settings"); setMenuOpen(false); setProfileMenuOpen(false); }} type="button">
                <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
                  <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="2" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.37a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.63 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.56-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                </svg>
                Settings
              </button>
            </section>
          ) : null}
          {profileMenuOpen ? (
            <section className="connect-header-menu connect-profile-menu">
              <div>
                <strong>{activeAccount?.name || activeAccount?.reference || "User"}</strong>
                {activeAccount?.reference ? <small>{activeAccount.reference}</small> : null}
                <span>{activeAccount?.email || activeAccount?.companyName || ""}</span>
              </div>
              {activeAccount ? <button onClick={() => selectAccount(activeAccount)} type="button">Profile</button> : null}
              <button className="danger" disabled={pending} onClick={logout} type="button">Sign out</button>
            </section>
          ) : null}
        </header>
      )}

      {error ? <div className="connect-alert error">{error}</div> : null}
      {notice ? <div className="connect-alert success">{notice}</div> : null}

      {checkingSession ? (
        <section className="connect-login-card">
          <p className="connect-help">Checking login...</p>
        </section>
      ) : step === "mobile" ? (
        <form className="connect-login-card" onSubmit={checkMobile}>
          <label>
            Country code
            <select className="field" name="countryCode" onChange={(event) => setCountryCode(event.target.value)} value={countryCode}>
              {countryCodeOptions.map((country) => (
                <option key={country.code} value={country.code}>{country.label}</option>
              ))}
            </select>
          </label>
          <label>
            Mobile number
            <input
              inputMode="tel"
              maxLength={15}
              name="mobile"
              onChange={(event) => setMobile(event.target.value.replace(/\D/g, "").slice(0, 15))}
              placeholder="Enter registered mobile number"
              required
              type="tel"
              value={mobile}
            />
          </label>
          <button className="connect-primary" disabled={pending || mobile.length < 6} type="submit">
            {pending ? "Checking..." : "Continue"}
          </button>
        </form>
      ) : step === "pin" ? (
        <form className="connect-login-card" onSubmit={verifyPin}>
          <label>
            App PIN
            <input
              inputMode="numeric"
              maxLength={6}
              name="pin"
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Enter 6 digit PIN"
              required
              type="password"
              value={pin}
            />
          </label>
          <button className="connect-primary" disabled={pending || pin.length !== 6} type="submit">
            {pending ? "Signing in..." : "Sign in"}
          </button>
          <button className="connect-text-button" disabled={pending} onClick={resetPin} type="button">Reset PIN</button>
          <button className="connect-text-button" onClick={() => { setStep("mobile"); setPin(""); setError(null); }} type="button">Change mobile number</button>
        </form>
      ) : step === "otp" ? (
        <form className="connect-login-card" onSubmit={submitOtp}>
          <label>
            WhatsApp OTP
            <input
              inputMode="numeric"
              maxLength={6}
              name="otp"
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Enter 6 digit OTP"
              required
              type="tel"
              value={otp}
            />
          </label>
          {expiresInMinutes ? <p className="connect-help">OTP valid for {expiresInMinutes} minutes.</p> : null}
          <button className="connect-primary" disabled={pending || otp.length !== 6} type="submit">
            Continue
          </button>
          <button className="connect-text-button" onClick={() => { setStep("mobile"); setOtp(""); setPin(""); setConfirmPin(""); setError(null); }} type="button">Change mobile number</button>
        </form>
      ) : step === "createPin" ? (
        <form className="connect-login-card" onSubmit={createPin}>
          <label>
            Create app PIN
            <input
              inputMode="numeric"
              maxLength={6}
              name="pin"
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Create 6 digit PIN"
              required
              type="password"
              value={pin}
            />
          </label>
          <label>
            Re-enter app PIN
            <input
              inputMode="numeric"
              maxLength={6}
              name="confirm_pin"
              onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Re-enter 6 digit PIN"
              required
              type="password"
              value={confirmPin}
            />
          </label>
          <button className="connect-primary" disabled={pending || pin.length !== 6 || confirmPin.length !== 6} type="submit">
            {pending ? "Saving..." : "Save PIN"}
          </button>
          <button className="connect-text-button" onClick={() => { setStep("otp"); setPin(""); setConfirmPin(""); setError(null); }} type="button">Back to OTP</button>
        </form>
      ) : step === "settings" ? (
        <section className="connect-login-card connect-settings-page">
          <div>
            <h2 className="connect-card-title">Settings</h2>
            <p className="connect-help">Choose how this device opens DropX Connect.</p>
          </div>
          <label>
            Default account
            <select onChange={(event) => saveDefaultAccount(event.target.value)} value={defaultAccountKey ?? ""}>
              <option value="">Select default account</option>
              {accounts.map((account) => (
                <option key={accountStorageKey(account)} value={accountStorageKey(account)}>
                  {account.companyName} - {account.reference || account.name || account.email || "User"}
                </option>
              ))}
            </select>
          </label>
          <button className="connect-secondary" onClick={() => setStep(selectedAccount ? selectedAccount.profileType === "employee" ? "profile" : "home" : "account")} type="button">Back</button>
        </section>
      ) : step === "exit" && selectedAccount ? (
        <ConnectExitManagement account={selectedAccount} onBack={() => setStep("profile")} />
      ) : (
        step === "profile" && selectedAccount ? (
        <ConnectProfileCompletion
          account={selectedAccount}
          onBack={() => {
            setSelectedAccount(null);
            setMenuOpen(false);
            setProfileMenuOpen(false);
            setStep("account");
          }}
          onLogout={logout}
        />
      ) : step === "home" && selectedAccount ? (
        <section className="connect-login-card">
          <div>
            <h2 className="connect-card-title">Welcome, {selectedAccount.name || selectedAccount.reference || "User"}</h2>
            <p className="connect-help">{selectedAccount.companyName}</p>
          </div>
          <p className="connect-help">This account workspace will be added next.</p>
          <div className="connect-account-actions">
            <button className="connect-secondary" onClick={() => { setSelectedAccount(null); setStep("account"); }} type="button">Back to accounts</button>
            <button className="connect-secondary danger" disabled={pending} onClick={logout} type="button">Logout</button>
          </div>
        </section>
      ) : (
        <section className="connect-login-card">
          <div>
            <h2 className="connect-card-title">Choose account</h2>
            <p className="connect-help">Select the company profile to continue.</p>
          </div>
          <div className="connect-account-list">
            {accounts.length ? accounts.map((account) => (
              <button className="connect-account-button" key={`${account.profileType}-${account.id}`} onClick={() => selectAccount(account)} type="button">
                <strong>{account.companyName}</strong>
                <span>{account.name || account.reference || account.email || "User"}</span>
                <small>{[account.reference, account.role, account.status].filter(Boolean).join(" | ") || account.profileType}</small>
              </button>
            )) : <p className="connect-help">No active account found for this mobile number.</p>}
          </div>
          <div className="connect-account-actions">
            <button className="connect-secondary danger" disabled={pending} onClick={logout} type="button">
              Logout
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}

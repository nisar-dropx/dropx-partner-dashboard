"use client";

import { useEffect, useState, type FormEvent } from "react";
import { countryCodeOptions } from "@/lib/country-codes";

type Step = "mobile" | "pin" | "otp" | "createPin" | "account";

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

  useEffect(() => {
    let isMounted = true;
    fetch("/api/connect/auth/session")
      .then((response) => response.json())
      .then((payload: { authenticated?: boolean; accounts?: ConnectAccount[] }) => {
        if (!isMounted || !payload.authenticated) return;
        setAccounts(payload.accounts ?? []);
        setStep("account");
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
      setAccounts(payload.accounts ?? []);
      setStep("account");
      setNotice("Signed in.");
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
      setAccounts(payload.accounts ?? []);
      setStep("account");
      setNotice("PIN created and signed in.");
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
      setMobile("");
      setPin("");
      setConfirmPin("");
      setOtp("");
      setStep("mobile");
      setNotice("Logged out. Enter mobile number to continue.");
      setPending(false);
    }
  }

  return (
    <div className="connect-login-stack">
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
          <button
            aria-busy={pending}
            className={`connect-primary${pending ? " loading" : ""}`}
            disabled={pending || pin.length !== 6}
            type="submit"
          >
            {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
            <span>{pending ? "Signing in..." : "Sign in"}</span>
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
      ) : (
        <section className="connect-login-card">
          <div>
            <h2 className="connect-card-title">Choose account</h2>
            <p className="connect-help">Select the company profile to continue.</p>
          </div>
          <div className="connect-account-list">
            {accounts.length ? accounts.map((account) => (
              <button className="connect-account-button" key={`${account.profileType}-${account.id}`} type="button">
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
      )}
    </div>
  );
}

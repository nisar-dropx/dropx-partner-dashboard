"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, MessageCircle, ShieldCheck } from "lucide-react";
import { signInWithGoogle } from "@/app/login/actions";

type PeopleLoginPanelProps = {
  initialMessage?: string | null;
  nextPath?: string;
};

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: unknown }).error ?? fallback);
  }
  return fallback;
}

export function PeopleLoginPanel({ initialMessage, nextPath = "/" }: PeopleLoginPanelProps) {
  const [mobile, setMobile] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"mobile" | "otp">("mobile");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [message, setMessage] = useState(initialMessage ?? "");
  const [resendSeconds, setResendSeconds] = useState(0);
  const cleanMobile = mobile.replace(/\D/g, "").slice(-10);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => setResendSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  async function sendOtp() {
    if (cleanMobile.length !== 10) {
      setMessage("Enter a valid 10 digit mobile number.");
      return;
    }
    setBusy("send");
    setMessage("");
    try {
      const response = await fetch("/api/people-auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile: cleanMobile, countryCode: "91" })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to send OTP."));
      setStep("otp");
      setResendSeconds(Number(payload.resendAfterSeconds ?? 60));
      setMessage("OTP sent to your registered WhatsApp number.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send OTP.");
    } finally {
      setBusy(null);
    }
  }

  async function verifyOtp() {
    if (!/^\d{6}$/.test(otp)) {
      setMessage("Enter the 6 digit OTP.");
      return;
    }
    setBusy("verify");
    setMessage("");
    try {
      const response = await fetch("/api/people-auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile: cleanMobile, countryCode: "91", otp, next: nextPath })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to verify OTP."));
      window.location.assign(String(payload.next || "/"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to verify OTP.");
      setBusy(null);
    }
  }

  return (
    <main className="people-login-page">
      <section className="people-login-card" aria-label="Sign in to DropX People">
        <div className="people-login-brand">
          <img src="/dropx-logo.png" alt="DropX" />
          <span aria-hidden="true" />
          <strong>People</strong>
        </div>

        <div className="people-login-copy">
          <span>DROPX LOGISTICS</span>
          <h1>People operations, in one place.</h1>
          <p>Secure HRMS for employees, attendance, leave and approvals.</p>
        </div>

        <div className="people-login-mobile-form">
          <label htmlFor="people-mobile">Registered mobile number</label>
          <div className="people-mobile-input-row">
            <span>+91</span>
            <input
              id="people-mobile"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="10 digit mobile number"
              value={mobile}
              disabled={step === "otp" || busy !== null}
              onChange={(event) => setMobile(event.target.value.replace(/\D/g, "").slice(0, 10))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && step === "mobile") void sendOtp();
              }}
            />
          </div>

          {step === "otp" ? (
            <div className="people-otp-section">
              <div className="people-otp-label-row">
                <label htmlFor="people-otp">WhatsApp OTP</label>
                <button
                  type="button"
                  onClick={() => { setStep("mobile"); setOtp(""); setMessage(""); }}
                  disabled={busy !== null}
                >
                  Change number
                </button>
              </div>
              <input
                id="people-otp"
                className="people-otp-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="• • • • • •"
                value={otp}
                maxLength={6}
                autoFocus
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void verifyOtp();
                }}
              />
            </div>
          ) : null}

          {message ? (
            <div
              className={step === "otp" && message.startsWith("OTP sent") ? "people-login-notice success" : "people-login-notice"}
              role="status"
            >
              {message}
            </div>
          ) : null}

          {step === "mobile" ? (
            <button className="people-primary-login" type="button" onClick={() => void sendOtp()} disabled={busy !== null}>
              {busy === "send" ? <LoaderCircle className="spin" size={16} /> : <MessageCircle size={16} />}
              {busy === "send" ? "Sending OTP" : "Continue with mobile"}
            </button>
          ) : (
            <div className="people-otp-actions">
              <button className="people-primary-login" type="button" onClick={() => void verifyOtp()} disabled={busy !== null}>
                {busy === "verify" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                {busy === "verify" ? "Signing in" : "Verify & sign in"}
              </button>
              <button type="button" disabled={resendSeconds > 0 || busy !== null} onClick={() => void sendOtp()}>
                {resendSeconds > 0 ? `Resend in ${resendSeconds}s` : "Resend OTP"}
              </button>
            </div>
          )}
        </div>

        <div className="people-login-divider"><span>or</span></div>

        <form action={signInWithGoogle}>
          <input name="next" type="hidden" value={nextPath} />
          <button className="people-google-login" type="submit">
            <img src="/google-g.svg" alt="" />
            Continue with Google
          </button>
        </form>

        <p className="people-login-footnote">Only active DropX users with a registered mobile number or authorised Google account can continue.</p>
      </section>
    </main>
  );
}

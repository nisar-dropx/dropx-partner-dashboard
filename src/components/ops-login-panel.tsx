"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, LoaderCircle, LockKeyhole, MessageCircle, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { signInWithGoogle } from "@/app/login/actions";

type OpsLoginPanelProps = {
  initialMessage?: string | null;
  nextPath?: string;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: unknown }).error ?? fallback);
  }
  return fallback;
}

export function OpsLoginPanel({ initialMessage, nextPath = "/" }: OpsLoginPanelProps) {
  const [mobile, setMobile] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"mobile" | "otp">("mobile");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [message, setMessage] = useState(initialMessage ?? "");
  const [resendSeconds, setResendSeconds] = useState(0);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => setResendSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  const cleanMobile = useMemo(() => mobile.replace(/\D/g, "").slice(-10), [mobile]);

  async function sendOtp() {
    if (cleanMobile.length !== 10) {
      setMessage("Enter a valid 10 digit mobile number.");
      return;
    }
    setBusy("send");
    setMessage("");
    try {
      const response = await fetch("/api/ops-auth/send-otp", {
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
      const response = await fetch("/api/ops-auth/verify-otp", {
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

  async function installWebApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  return (
    <main className="ops-login-page">
      <section className="ops-login-story" aria-label="OpsPulse overview">
        <div className="ops-login-brand">
          <img src="/dropx-logo.png" alt="DropX" />
          <span aria-hidden="true" />
          <div>
            <strong>OpsPulse</strong>
            <small>Operations intelligence</small>
          </div>
        </div>
        <div className="ops-login-story-copy">
          <span className="ops-login-kicker">ONE OPERATING VIEW</span>
          <h1>Run every station from one clear pulse.</h1>
          <p>Performance, capacity, cash, fleet and action queues—secured to your assigned role and locations.</p>
        </div>
        <div className="ops-login-proof">
          <div><MonitorSmartphone size={20} /><span><strong>Built for every screen</strong><small>Phone, tablet and desktop</small></span></div>
          <div><ShieldCheck size={20} /><span><strong>Scope-safe by design</strong><small>Only your permitted operations</small></span></div>
        </div>
      </section>

      <section className="ops-login-access" aria-label="Sign in to OpsPulse">
        <div className="ops-login-card">
          <div className="ops-login-card-heading">
            <span className="ops-login-card-icon"><LockKeyhole size={22} /></span>
            <div>
              <span className="ops-login-kicker">SECURE ACCESS</span>
              <h2>Sign in to OpsPulse</h2>
              <p>Use your registered mobile or company Google account.</p>
            </div>
          </div>

          <div className="ops-login-mobile-form">
            <label htmlFor="ops-mobile">Registered mobile number</label>
            <div className="ops-mobile-input-row">
              <span className="ops-country-code">+91</span>
              <input
                id="ops-mobile"
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
              <div className="ops-otp-section">
                <div className="ops-otp-label-row">
                  <label htmlFor="ops-otp">WhatsApp OTP</label>
                  <button type="button" onClick={() => { setStep("mobile"); setOtp(""); setMessage(""); }} disabled={busy !== null}>Change number</button>
                </div>
                <input
                  id="ops-otp"
                  className="ops-otp-input"
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

            {message ? <div className={step === "otp" && message.startsWith("OTP sent") ? "ops-login-notice success" : "ops-login-notice"} role="status">{message}</div> : null}

            {step === "mobile" ? (
              <button className="ops-primary-login" type="button" onClick={() => void sendOtp()} disabled={busy !== null}>
                {busy === "send" ? <LoaderCircle className="spin" size={18} /> : <MessageCircle size={18} />}
                {busy === "send" ? "Sending OTP" : "Send WhatsApp OTP"}
              </button>
            ) : (
              <div className="ops-otp-actions">
                <button className="ops-primary-login" type="button" onClick={() => void verifyOtp()} disabled={busy !== null}>
                  {busy === "verify" ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}
                  {busy === "verify" ? "Signing in" : "Verify & sign in"}
                </button>
                <button className="ops-resend-button" type="button" disabled={resendSeconds > 0 || busy !== null} onClick={() => void sendOtp()}>
                  {resendSeconds > 0 ? `Resend in ${resendSeconds}s` : "Resend OTP"}
                </button>
              </div>
            )}
          </div>

          <div className="ops-login-divider"><span>or</span></div>
          <form action={signInWithGoogle}>
            <input name="next" type="hidden" value={nextPath} />
            <button className="ops-google-login" type="submit">
              <img src="/google-g.svg" alt="" />
              Continue with Google
            </button>
          </form>

          <p className="ops-access-footnote">Access is available only to active users enabled for OpsPulse.</p>
        </div>

        <div className="ops-app-downloads">
          <a className="ops-apk-download" href="/downloads/DropX-OpsPulse.apk" download>
            <Download size={18} />
            <span><strong>Download Android app</strong><small>Latest verified APK</small></span>
          </a>
          {installPrompt ? (
            <button type="button" onClick={() => void installWebApp()}>
              <MonitorSmartphone size={18} /> Install web app
            </button>
          ) : (
            <p>iPhone: open in Safari, tap Share, then “Add to Home Screen”.</p>
          )}
        </div>
      </section>
    </main>
  );
}

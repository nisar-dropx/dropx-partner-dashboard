"use client";

import { useState } from "react";
import { MessageCircle, ShieldCheck } from "lucide-react";

export function FleetOtpLogin({ nextPath }: { nextPath: string }) {
  const [mobile, setMobile] = useState("");
  const [countryCode, setCountryCode] = useState("91");
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/fleet/auth/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile, countryCode })
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to send OTP.");
      setOtpSent(true);
      setMessage("OTP sent to your WhatsApp.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send OTP.");
    } finally {
      setPending(false);
    }
  }

  async function verify() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/fleet/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile, countryCode, otp, next: nextPath })
      });
      const payload = await response.json() as { error?: string; next?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to verify OTP.");
      window.location.assign(payload.next || "/fleet-control");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to verify OTP.");
      setPending(false);
    }
  }

  return <div className="fleet-otp-login">
    <div className="fleet-login-divider"><span>or use mobile</span></div>
    <div className="fleet-mobile-field">
      <select aria-label="Country code" disabled={otpSent || pending} onChange={(event) => setCountryCode(event.target.value)} value={countryCode}>
        <option value="91">+91</option>
        <option value="971">+971</option>
      </select>
      <input disabled={otpSent || pending} inputMode="tel" maxLength={15} onChange={(event) => setMobile(event.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="Registered mobile number" type="tel" value={mobile} />
    </div>
    {otpSent ? <>
      <div className="fleet-mobile-field otp"><ShieldCheck size={18} /><input autoFocus inputMode="numeric" maxLength={6} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 digit OTP" value={otp} /></div>
      <button className="fleet-otp-primary" disabled={pending || otp.length !== 6} onClick={verify} type="button">{pending ? "Verifying…" : "Verify and sign in"}</button>
      <button className="fleet-otp-link" disabled={pending} onClick={() => { setOtpSent(false); setOtp(""); setMessage(null); }} type="button">Change mobile number</button>
    </> : <div className="fleet-otp-actions single">
      <button className="whatsapp" disabled={pending || mobile.length < 8} onClick={send} type="button"><MessageCircle size={16} /> Continue with WhatsApp OTP</button>
    </div>}
    {message ? <p className="fleet-otp-message" role="status">{message}</p> : null}
  </div>;
}

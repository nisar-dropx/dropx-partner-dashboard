"use client";

import { Check, Clock3, Copy, Mail, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { amazonOtpView, type AmazonOtpResponse, type AmazonOtpWait } from "../lib/beta-amazon-otp";
import styles from "./connect-beta-amazon-otp.module.css";

const wording = {
  en: {
    label: "AMAZON EMAIL VERIFICATION", title: "Your verification code", waiting: "Waiting for your new code",
    empty: "Amazon asking for an OTP?", emptyBody: "Keep Amazon’s verification page open. Your email code will appear here automatically.",
    instruction: "Copy this code, return to Amazon and paste it into “Enter security code”.",
    older: "Request a fresh code", olderBody: "The latest email is older. Amazon decides when a code expires; request a new one if needed.",
    unreadable: "We received an email, but couldn’t read its code", unreadableBody: "Request another code on Amazon. If it still does not appear, use Call for help.",
    resend: "Need a new code?", resendTitle: "Resend from Amazon", resendBody: "On Amazon’s verification page, tap “Resend code”. Keep that page open, then return here. DropX will show the new email automatically.",
    previous: "The previous code is hidden while you wait. Only Amazon can send another code.",
    delayed: "Taking longer than usual? Check that Amazon shows the email above. Follow any wait time on Amazon before tapping “Resend code” again, or use Call for help.",
    check: "Check for new code", checking: "Checking inbox…", automatic: "Updates automatically · every 15 seconds",
    received: "Email received", copy: "Copy code", copied: "Code copied", copyError: "Press and hold the code to copy it.",
    offline: "You’re offline. Reconnect to check for your code.", error: "We couldn’t check your inbox. Try again; your Amazon page can stay open.",
    signin: "Reopen your beta account to check this private inbox.", retry: "Try again", privacy: "Visible only in your own beta account. Never share this code.",
  },
  ml: {
    label: "AMAZON ഇമെയിൽ സ്ഥിരീകരണം", title: "നിങ്ങളുടെ സ്ഥിരീകരണ കോഡ്", waiting: "പുതിയ കോഡിനായി കാത്തിരിക്കുന്നു",
    empty: "Amazon OTP ചോദിക്കുന്നുണ്ടോ?", emptyBody: "Amazon സ്ഥിരീകരണ പേജ് തുറന്നുവയ്ക്കുക. ഇമെയിലിൽ വരുന്ന കോഡ് ഇവിടെ സ്വയം കാണിക്കും.",
    instruction: "ഈ കോഡ് കോപ്പി ചെയ്ത് Amazon-ലേക്ക് മടങ്ങുക. “Enter security code” എന്നിടത്ത് പേസ്റ്റ് ചെയ്യുക.",
    older: "പുതിയ കോഡ് ആവശ്യപ്പെടുക", olderBody: "അവസാനം ലഭിച്ച ഇമെയിൽ പഴയതാണ്. കോഡിന്റെ കാലാവധി Amazon തീരുമാനിക്കുന്നു. ആവശ്യമെങ്കിൽ പുതിയ കോഡ് ആവശ്യപ്പെടുക.",
    unreadable: "ഇമെയിൽ ലഭിച്ചു, പക്ഷേ കോഡ് വായിക്കാനായില്ല", unreadableBody: "Amazon-ൽ വീണ്ടും കോഡ് ആവശ്യപ്പെടുക. ഇനിയും കാണുന്നില്ലെങ്കിൽ സഹായത്തിനായി വിളിക്കുക.",
    resend: "പുതിയ കോഡ് വേണോ?", resendTitle: "Amazon-ൽ നിന്ന് വീണ്ടും അയയ്ക്കുക", resendBody: "Amazon സ്ഥിരീകരണ പേജിൽ “Resend code” അമർത്തുക. ആ പേജ് തുറന്നുവച്ച് ഇവിടെ തിരിച്ചുവരിക. പുതിയ ഇമെയിൽ ലഭിച്ചാൽ കോഡ് സ്വയം കാണിക്കും.",
    previous: "കാത്തിരിക്കുമ്പോൾ പഴയ കോഡ് മറച്ചിരിക്കുന്നു. പുതിയ കോഡ് അയയ്ക്കാൻ Amazon-ന് മാത്രമേ കഴിയൂ.",
    delayed: "വൈകുന്നുണ്ടോ? Amazon-ൽ മുകളിൽ കാണുന്ന അതേ ഇമെയിലാണെന്ന് ഉറപ്പാക്കുക. Amazon പറയുന്ന സമയം കാത്തിരുന്നശേഷം “Resend code” വീണ്ടും അമർത്തുക, അല്ലെങ്കിൽ സഹായത്തിനായി വിളിക്കുക.",
    check: "പുതിയ കോഡ് പരിശോധിക്കുക", checking: "ഇൻബോക്സ് പരിശോധിക്കുന്നു…", automatic: "ഓരോ 15 സെക്കൻഡിലും സ്വയം പുതുക്കും",
    received: "ഇമെയിൽ ലഭിച്ചത്", copy: "കോഡ് കോപ്പി ചെയ്യുക", copied: "കോഡ് കോപ്പി ചെയ്തു", copyError: "കോഡ് അമർത്തിപ്പിടിച്ച് കോപ്പി ചെയ്യുക.",
    offline: "ഇന്റർനെറ്റ് ലഭ്യമല്ല. കണക്ഷൻ വന്നശേഷം കോഡ് പരിശോധിക്കുക.", error: "ഇൻബോക്സ് പരിശോധിക്കാനായില്ല. വീണ്ടും ശ്രമിക്കുക. Amazon പേജ് തുറന്നുവയ്ക്കാം.",
    signin: "ഈ സ്വകാര്യ ഇൻബോക്സ് കാണാൻ നിങ്ങളുടെ ബീറ്റ അക്കൗണ്ട് വീണ്ടും തുറക്കുക.", retry: "വീണ്ടും ശ്രമിക്കുക", privacy: "നിങ്ങളുടെ സ്വന്തം ബീറ്റ അക്കൗണ്ടിൽ മാത്രം കാണാം. കോഡ് മറ്റാരുമായും പങ്കിടരുത്.",
  },
};

export function ConnectBetaAmazonOtp({ accountId, companyId, language = "en" }: {
  accountId: string; companyId: string; language?: string;
}) {
  const copy = language === "ml" ? wording.ml : wording.en;
  const headingId = useId();
  const storageKey = `dropx-beta-otp-wait:${companyId}:${accountId}`;
  const [data, setData] = useState<AmazonOtpResponse | null>(null);
  const [wait, setWait] = useState<AmazonOtpWait | null>(null);
  const [error, setError] = useState<"offline" | "error" | "signin" | null>(null);
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now), [clockOffset, setClockOffset] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null), [copyError, setCopyError] = useState(false);

  useEffect(() => {
    try {
      // Retain only the resend cursor when returning from Amazon. Never store the OTP.
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved.startedAt === "number" && Date.now() - saved.startedAt < 30 * 60_000
        && (saved.messageId === null || typeof saved.messageId === "string")
        && (saved.receivedAt === null || Number.isFinite(Date.parse(saved.receivedAt)))) setWait(saved);
    } catch { /* Storage may be unavailable in a private browser. */ }
  }, [storageKey]);

  useEffect(() => {
    let disposed = false, controller: AbortController | null = null, denied = false;
    const check = async () => {
      if (disposed || controller || denied || document.visibilityState !== "visible") return;
      if (!navigator.onLine) { setError("offline"); return; }
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10_000);
      setBusy(true);
      try {
        const query = new URLSearchParams({ accountId, profileType: "workforce" });
        const response = await fetch(`/api/connect/beta-amazon-otp?${query}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401 || response.status === 403) { denied = true; throw new Error("signin"); }
        if (!response.ok) throw new Error("error");
        const result: AmazonOtpResponse = await response.json();
        if (!disposed) {
          setData(result); setError(null); setNow(Date.now());
          setClockOffset(Date.parse(result.checkedAt) - Date.now());
        }
      } catch (reason) {
        if (!disposed) setError(!navigator.onLine ? "offline" : reason instanceof Error && reason.message === "signin" ? "signin" : "error");
      } finally {
        window.clearTimeout(timeout); controller = null;
        if (!disposed) setBusy(false);
      }
    };
    const visibility = () => { if (document.visibilityState === "visible") void check(); };
    const offline = () => setError("offline");
    void check();
    const polling = window.setInterval(() => { setNow(Date.now()); void check(); }, 15_000);
    window.addEventListener("focus", visibility);
    window.addEventListener("online", visibility);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true; controller?.abort(); window.clearInterval(polling);
      window.removeEventListener("focus", visibility); window.removeEventListener("online", visibility);
      window.removeEventListener("offline", offline); document.removeEventListener("visibilitychange", visibility);
    };
  }, [accountId, refresh]);

  const view = amazonOtpView(data?.latest ?? null, wait, now + clockOffset);
  useEffect(() => {
    if (wait && view.state === "received") {
      setWait(null);
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional cursor only. */ }
    }
  }, [wait, view.state, storageKey]);

  const requestNew = () => {
    const cursor = { messageId: data?.latest?.id ?? null, receivedAt: data?.latest?.receivedAt ?? null, startedAt: Date.now() + clockOffset };
    setWait(cursor); setNow(Date.now()); setCopiedId(null); setCopyError(false);
    try { sessionStorage.setItem(storageKey, JSON.stringify(cursor)); } catch { /* No code is persisted. */ }
    setRefresh(value => value + 1);
  };
  const copyCode = async () => {
    if (!view.code || !data?.latest || error) return;
    try { await navigator.clipboard.writeText(view.code); setCopiedId(data.latest.id); setCopyError(false); }
    catch { setCopyError(true); }
  };
  const title = view.state === "waiting" ? copy.waiting : view.state === "older" ? copy.older
    : view.state === "unreadable" ? copy.unreadable : view.state === "empty" ? copy.empty : copy.title;

  return <section className={styles.card} aria-labelledby={headingId} lang={language === "ml" ? "ml" : "en"}>
    <header><span className={styles.icon}><Mail size={22}/></span><div><small>{copy.label}</small><h3 id={headingId}>{title}</h3></div></header>
    <div aria-live="polite" aria-atomic="true">
      {error ? <p className={styles.warning}>{copy[error]}</p> : view.state === "received" && view.code ? <>
        <div className={styles.codeRow}><strong className={styles.code} aria-label={`OTP ${view.code.split("").join(" ")}`}>{view.code}</strong>
          <button className={styles.primary} onClick={() => void copyCode()}>{copiedId === data?.latest?.id ? <Check size={18}/> : <Copy size={18}/>}{copiedId === data?.latest?.id ? copy.copied : copy.copy}</button></div>
        <p>{copy.instruction}</p>
        <small className={styles.timestamp}>{copy.received} · {new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(data!.latest!.receivedAt))} IST</small>
      </> : view.state === "waiting" ? <div className={styles.resend}><strong>{copy.resendTitle}</strong><p>{copy.resendBody}</p><small>{copy.previous}</small>{view.delayed ? <p className={styles.warning}>{copy.delayed}</p> : null}</div>
        : <p>{view.state === "older" ? copy.olderBody : view.state === "unreadable" ? copy.unreadableBody : copy.emptyBody}</p>}
      {copyError ? <p className={styles.warning}>{copy.copyError}</p> : null}
    </div>
    <footer><button className={styles.secondary} disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16}/>{busy ? copy.checking : error ? copy.retry : copy.check}</button>
      {view.state !== "waiting" && data ? <button className={styles.link} onClick={requestNew}>{copy.resend}</button> : null}</footer>
    <div className={styles.meta}><Clock3 size={13}/><span>{copy.automatic}</span></div>
    <small className={styles.privacy}>{copy.privacy}</small>
  </section>;
}

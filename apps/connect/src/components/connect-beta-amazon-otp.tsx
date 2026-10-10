"use client";

import { Check, Clock3, Copy, Mail, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { amazonOtpView, type AmazonOtpResponse, type AmazonOtpWait } from "../lib/beta-amazon-otp";
import styles from "./connect-beta-amazon-otp.module.css";

import { betaAmazonOtpCopy } from "../lib/beta-amazon-otp-copy";
import type { GuidanceLanguage } from "../lib/beta-guidance";

export function ConnectBetaAmazonOtp({ accountId, companyId, language = "en" }: {
  accountId: string; companyId: string; language?: GuidanceLanguage;
}) {
  const copy = betaAmazonOtpCopy[language];
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

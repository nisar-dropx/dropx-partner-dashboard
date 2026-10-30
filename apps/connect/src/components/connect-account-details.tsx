"use client";

import { useEffect, useState } from "react";
import { Copy, Mail, ChevronRight, RefreshCw } from "lucide-react";
import type { AppAccount } from "./connect-profile-app";
import type { BetaWorkforceIdentity } from "../lib/beta-workforce-identity";
import styles from "./connect-account-details.module.css";

export function ConnectAccountDetails({ account, onHistory, onInbox }: {
  account: AppAccount; onHistory: () => void; onInbox?: () => void;
}) {
  const [identity, setIdentity] = useState<BetaWorkforceIdentity | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    let disposed = false;
    setIdentity(null); setState("loading"); setNotice("");
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date());
    const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType, month, attendance: "0" });
    void fetch(`/api/connect/beta-workspace?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Unavailable");
        const data = await response.json();
        if (!disposed) { setIdentity(data.identity ?? null); setState("ready"); }
      }).catch(() => { if (!disposed) setState("error"); })
      .finally(() => window.clearTimeout(timeout));
    return () => { disposed = true; controller.abort(); window.clearTimeout(timeout); };
  }, [account.id, account.profileType, attempt]);
  async function copy(label: string, value: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied`); }
    catch { setNotice("Could not copy. Select and copy the value below."); }
  }
  const fields = [
    ["DropX employee ID", identity?.dropxId || account.reference],
    ["Amazon Driver ID", identity?.driverId],
    ["Amazon payment ID", identity?.providerId],
    ["Biometric ID", account.biometricId],
    ["Amazon sign-in email", identity?.email || account.email]
  ];
  return <section className={styles.card} aria-label="Work accounts">
    <header><div><h2>Work accounts</h2><p>Your IDs, Amazon email and setup records.</p></div></header>
    <dl className={styles.grid}>{fields.map(([label, value]) => <div key={label} className={label === "Amazon sign-in email" ? styles.email : undefined}>
      <dt>{label}</dt><dd><span>{value || (state === "loading" ? "Loading…" : "Not available yet")}</span>{value ? <button type="button" aria-label={`Copy ${label}`} onClick={() => void copy(label!, value)}><Copy size={16} /></button> : null}</dd>
    </div>)}</dl>
    {state === "error" ? <p role="alert">IDs could not refresh. <button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />Retry</button></p> : null}
    <span role="status" className={styles.notice}>{notice}</span>
    <footer>{onInbox ? <button type="button" onClick={onInbox}><Mail size={18} />Mail inbox<ChevronRight size={16} /></button> : null}<button type="button" onClick={onHistory}>View onboarding records<ChevronRight size={16} /></button></footer>
  </section>;
}

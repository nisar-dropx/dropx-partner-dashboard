"use client";

import { useEffect, useState } from "react";
import s from "@/app/ops-pulse/report-bot/report-bot.module.css";

type SessionView = {
  state: string;
  qr_image?: string | null;
  pairing_code?: string | null;
  number?: string | null;
  name?: string | null;
  error?: string | null;
};

const LABELS: Record<string, string> = {
  unknown: "Not set up",
  idle: "Not linked",
  connecting: "Connecting…",
  qr: "Waiting for QR scan",
  pairing: "Waiting for pairing code",
  open: "Connected",
  closed: "Reconnecting…",
  logged_out: "Not linked",
  unreachable: "Worker unreachable"
};

const LINKING = ["qr", "pairing", "connecting", "closed"];

/** Live WhatsApp link status. Polls fast while linking, slowly once connected. */
export function ReportBotConnection({ initial, polling }: { initial: SessionView; polling: boolean }) {
  const [session, setSession] = useState<SessionView>(initial);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch("/api/report-bot/session", { cache: "no-store" });
        const next = await response.json() as SessionView;
        if (!cancelled) setSession(response.ok ? next : { state: "unreachable", error: next.error ?? "Could not load status." });
      } catch {
        if (!cancelled) setSession({ state: "unreachable", error: "Could not reach the portal." });
      }
      if (!cancelled) timer = setTimeout(poll, document.hidden ? 30000 : LINKING.includes(session.state) ? 3000 : 15000);
    };
    timer = setTimeout(poll, 800);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, session.state]);

  const tone = session.state === "open" ? s.good : LINKING.includes(session.state) ? s.warn : s.bad;
  return (
    <div className={s.session} aria-live="polite">
      <div className={s.sessionState}>
        <span className={`${s.badge} ${tone}`}>{LABELS[session.state] ?? session.state}</span>
        {session.state === "open" && session.number ? <strong>+{session.number}{session.name ? ` · ${session.name}` : ""}</strong> : null}
      </div>
      {session.error && session.state !== "open" ? <p className={s.hint} role="alert">{session.error}</p> : null}
      {session.state === "qr" && session.qr_image ? (
        <div className={s.qr}>
          {/* eslint-disable-next-line @next/next/no-img-element -- QR is a data URL rendered on the server */}
          <img src={session.qr_image} alt="QR code to link WhatsApp" width={240} height={240} />
          <ol>
            <li>Open WhatsApp on the phone</li>
            <li>Settings → Linked devices → Link a device</li>
            <li>Point the camera at this code</li>
          </ol>
        </div>
      ) : null}
      {session.state === "pairing" && session.pairing_code ? (
        <div className={s.qr}>
          <div className={s.pairing}>{session.pairing_code}</div>
          <ol>
            <li>Open WhatsApp → Settings → Linked devices</li>
            <li>Link a device → Link with phone number instead</li>
            <li>Enter this code</li>
          </ol>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

type SessionView = {
  state: string;
  qr_image?: string | null;
  pairing_code?: string | null;
  number?: string | null;
  name?: string | null;
  error?: string | null;
};

const LABELS: Record<string, string> = {
  idle: "Not linked",
  connecting: "Connecting…",
  qr: "Waiting for QR scan",
  pairing: "Waiting for pairing code",
  open: "Connected",
  closed: "Reconnecting…",
  logged_out: "Unlinked",
  unreachable: "Worker unreachable"
};

/** Polls the worker while linking; slows down once connected. */
export function ReportBotConnection({ initial }: { initial: SessionView }) {
  const [session, setSession] = useState<SessionView>(initial);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch("/api/report-bot/session", { cache: "no-store" });
        const next = await response.json() as SessionView & { error?: string };
        if (!cancelled) setSession(response.ok ? next : { state: "unreachable", error: next.error ?? "Could not load status." });
      } catch {
        if (!cancelled) setSession({ state: "unreachable", error: "Could not reach the portal." });
      }
      if (!cancelled) {
        const linking = ["qr", "pairing", "connecting", "closed"].includes(session.state);
        timer = setTimeout(poll, document.hidden ? 30000 : linking ? 3000 : 15000);
      }
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // The poll interval adapts on each run; restarting on state change keeps it current.
  }, [session.state]);

  const tone = session.state === "open" ? "good" : ["qr", "pairing", "connecting", "closed"].includes(session.state) ? "warn" : "bad";
  return (
    <div className="report-bot-session" aria-live="polite">
      <p>
        <span className={`status-pill ${tone}`}>{LABELS[session.state] ?? session.state}</span>
        {session.state === "open" && session.number ? <strong style={{ marginLeft: 10 }}>+{session.number}{session.name ? ` · ${session.name}` : ""}</strong> : null}
      </p>
      {session.error && session.state !== "open" ? <p className="subtle" role="alert">{session.error}</p> : null}
      {session.state === "qr" && session.qr_image ? (
        <figure style={{ margin: "12px 0" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated server-side */}
          <img src={session.qr_image} alt="WhatsApp link QR code" width={280} height={280} style={{ background: "#fff", padding: 8, borderRadius: 8 }} />
          <figcaption className="subtle">WhatsApp → Settings → Linked devices → Link a device. The code refreshes automatically.</figcaption>
        </figure>
      ) : null}
      {session.state === "pairing" && session.pairing_code ? (
        <p style={{ margin: "12px 0" }}>
          Pairing code: <strong style={{ fontSize: 24, letterSpacing: 4 }}>{session.pairing_code}</strong>
          <br /><span className="subtle">WhatsApp → Linked devices → Link a device → Link with phone number instead.</span>
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { HardDrive, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureMarshSessionAction,
  getMarshSessionStatus,
  startMarshLogin,
  submitMarshOtp,
  syncMarshEcardsAction,
  type MarshSessionView,
} from "@/app/settings/marsh-actions";
import styles from "./marsh-insurance-panel.module.css";

type Props = {
  canEdit: boolean;
  initial: MarshSessionView;
};

type LiveEvent = {
  id: string;
  at: string;
  tone: "info" | "warn" | "good" | "danger";
  text: string;
};

function statusTone(status: string) {
  if (status === "active") return "good";
  if (status === "otp_required" || status === "connecting") return "warn";
  if (status === "failed" || status === "expired") return "danger";
  return "";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function metricTone(status: string) {
  if (status === "active") return styles.metricGood;
  if (status === "otp_required" || status === "connecting") return styles.metricWarn;
  if (status === "failed" || status === "expired") return styles.metricDanger;
  return styles.metricIdle;
}

function mergeSession(prev: MarshSessionView, next: MarshSessionView): MarshSessionView {
  return {
    ...prev,
    ...next,
    driveConfigured: next.driveConfigured ?? prev.driveConfigured,
  };
}

function cookieLabel(session: MarshSessionView) {
  if (!session.cookiePresent) return "None";
  if (session.cookieAgeSeconds == null) return "Present";
  const minutes = Math.max(0, Math.round(session.cookieAgeSeconds / 60));
  return `${minutes} min old`;
}

function describeStatus(view: MarshSessionView): { tone: LiveEvent["tone"]; text: string } {
  switch (view.status) {
    case "connecting":
      return { tone: "info", text: "Connecting to Marsh identity… submitting encrypted credentials." };
    case "otp_required":
      return { tone: "warn", text: "OTP required — check the Marsh email inbox and enter the code below." };
    case "active":
      return { tone: "good", text: "Session active. Cookie stored for enroll, terminate, and ecard sync." };
    case "failed":
      return { tone: "danger", text: view.lastError || "Marsh login failed." };
    case "expired":
      return { tone: "danger", text: "Session expired — connect again." };
    default:
      return { tone: "info", text: `Status: ${statusLabel(view.status)}` };
  }
}

export function MarshInsurancePanel({ canEdit, initial }: Props) {
  const [session, setSession] = useState(initial);
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastStampRef = useRef("");

  const pushEvent = useCallback((tone: LiveEvent["tone"], text: string) => {
    setEvents((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toLocaleTimeString(),
        tone,
        text,
      },
      ...prev,
    ].slice(0, 12));
  }, []);

  const stopEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const applyView = useCallback(
    (view: MarshSessionView, announce = true) => {
      setSession((prev) => mergeSession(prev, view));
      const stamp = `${view.status}:${view.updatedAt}:${view.lastError}:${view.challengeId}`;
      if (announce && stamp !== lastStampRef.current) {
        lastStampRef.current = stamp;
        const desc = describeStatus(view);
        pushEvent(desc.tone, desc.text);
      }
      if (["active", "failed", "expired", "otp_required"].includes(view.status)) {
        stopEvents();
      }
    },
    [pushEvent, stopEvents],
  );

  const startEventStream = useCallback(() => {
    stopEvents();
    const source = new EventSource("/api/settings/marsh/session-events");
    eventSourceRef.current = source;
    source.addEventListener("status", (event) => {
      try {
        applyView(JSON.parse((event as MessageEvent).data) as MarshSessionView);
      } catch {
        /* ignore malformed frames */
      }
    });
    source.addEventListener("end", () => stopEvents());
    source.onerror = () => {
      // Fall back to polling if the stream drops.
      stopEvents();
    };
  }, [applyView, stopEvents]);

  useEffect(() => () => stopEvents(), [stopEvents]);

  useEffect(() => {
    if (!["connecting", "otp_required"].includes(session.status) || eventSourceRef.current) return;
    const timer = window.setInterval(() => {
      void getMarshSessionStatus()
        .then((json) => applyView(json))
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [session.status, applyView]);

  async function run(
    action: () => Promise<MarshSessionView | { ok: boolean; error?: string }>,
    okMessage: string,
  ) {
    setError(null);
    setMessage(null);
    setPending(true);
    try {
      const result = await action();
      if ("status" in result) {
        applyView(result as MarshSessionView);
        if (result.status === "active") {
          setMessage(okMessage);
          return;
        }
        const failed =
          ("ok" in result && result.ok === false) ||
          ["failed", "expired"].includes(String(result.status));
        if (failed) {
          const text = result.error || result.lastError || "Marsh session action failed.";
          setError(text);
          pushEvent("danger", text);
          return;
        }
      }
      if ("error" in result && result.error) {
        // Recover if the worker already activated the session while the UI refresh failed.
        const latest = await getMarshSessionStatus().catch(() => null);
        if (latest?.status === "active") {
          applyView(latest);
          setMessage(okMessage);
          return;
        }
        setError(String(result.error));
        pushEvent("danger", String(result.error));
        return;
      }
      setMessage(okMessage);
    } catch (err: unknown) {
      const latest = await getMarshSessionStatus().catch(() => null);
      if (latest?.status === "active") {
        applyView(latest);
        setMessage(okMessage);
        return;
      }
      const text = err instanceof Error ? err.message : "Request failed";
      setError(text);
      pushEvent("danger", text);
    } finally {
      setPending(false);
    }
  }

  async function connectMarsh() {
    setError(null);
    setMessage(null);
    setPending(true);
    setSession((prev) => ({ ...prev, status: "connecting", lastError: null }));
    lastStampRef.current = "";
    pushEvent("info", "Connect Marsh clicked — opening live status stream.");
    startEventStream();
    try {
      const result = await startMarshLogin();
      applyView(result);
      const failed =
        ("ok" in result && result.ok === false) ||
        ["failed", "expired"].includes(String(result.status));
      if (failed) {
        setError(result.lastError || "Marsh login failed.");
        return;
      }
      if (result.status === "otp_required") {
        setMessage("Login reached email OTP — enter the code from Marsh.");
      } else if (result.status === "active") {
        setMessage("Marsh session is active.");
      }
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : "Request failed";
      setError(text);
      pushEvent("danger", text);
      setSession((prev) => ({ ...prev, status: "failed", lastError: text }));
      stopEvents();
    } finally {
      setPending(false);
    }
  }

  const needsOtp = session.status === "otp_required";
  const sessionReady = session.status === "active";

  return (
    <div className={styles.page}>
      <section className={`summary-grid ${styles.metrics}`}>
        <article className={`metric-card ${metricTone(session.status)}`}>
          <span>Session</span>
          <strong style={{ textTransform: "capitalize" }}>{statusLabel(session.status)}</strong>
          <small>
            {sessionReady
              ? "Ready for enroll jobs"
              : needsOtp
                ? "Enter the email OTP below"
                : session.status === "connecting"
                  ? "Talking to Marsh…"
                  : "Connect to start"}
          </small>
        </article>
        <article className={`metric-card ${session.credentialsConfigured ? styles.metricGood : styles.metricDanger}`}>
          <span>Credentials</span>
          <strong>{session.credentialsConfigured ? "Configured" : "Missing"}</strong>
          <small>{session.credentialsConfigured ? "Portal secrets on the worker" : "Set MARSH_PORTAL_* secrets"}</small>
        </article>
        <article className={`metric-card ${session.cookiePresent ? styles.metricGood : styles.metricIdle}`}>
          <span>Cookie</span>
          <strong>{cookieLabel(session)}</strong>
          <small>{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "No session yet"}</small>
        </article>
        <article className={`metric-card ${session.driveConfigured ? styles.metricGood : styles.metricWarn}`}>
          <span>Drive sync</span>
          <strong>{session.driveConfigured ? "Ready" : "Setup needed"}</strong>
          <small>{session.driveConfigured ? "GMC + GPA cards upload folder" : "Google OAuth + folder ID"}</small>
        </article>
      </section>

      {session.lastError ? (
        <div className="alert danger">
          <strong>Last portal error</strong>
          <span>{session.lastError}</span>
        </div>
      ) : null}
      {error ? (
        <div className="alert danger">
          <strong>Unable to continue</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {message ? (
        <div className="alert success">
          <strong>Done</strong>
          <span>{message}</span>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Connect Marsh</h2>
            <p className="subtle">
              Portal email and password stay on the worker. Connect once, enter the email OTP here, then enroll and ecard jobs reuse the cookie.
            </p>
          </div>
          <span className={`status-pill ${statusTone(session.status)}`}>{statusLabel(session.status)}</span>
        </div>

        <div className={styles.panelBody}>
          <div className={styles.steps}>
            <article className={styles.step}>
              <span className={styles.stepIndex}>1</span>
              <strong>Connect</strong>
              <p>Start the Qover identity login using the worker secrets.</p>
            </article>
            <article className={styles.step}>
              <span className={styles.stepIndex}>2</span>
              <strong>Verify OTP</strong>
              <p>Enter the one-time code from the Marsh email. It is never stored.</p>
            </article>
            <article className={styles.step}>
              <span className={styles.stepIndex}>3</span>
              <strong>Sync cards</strong>
              <p>Pull GMC and GPA ecards into Drive for DropX One and HRMS.</p>
            </article>
          </div>

          {events.length ? (
            <div className={styles.eventLog}>
              <header>
                <strong>Live status</strong>
                <span>data events from the worker session stream</span>
              </header>
              <ul>
                {events.map((event) => (
                  <li key={event.id} data-tone={event.tone}>
                    <time>{event.at}</time>
                    <span>{event.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {needsOtp ? (
            <div className={styles.otpCard}>
              <header>
                <div>
                  <h3>Email OTP required</h3>
                  <p>Check the Marsh / Qover mailbox and enter the code before it expires (~10 minutes).</p>
                </div>
                <span className="status-pill warn">Waiting</span>
              </header>
              <label className={styles.otpField}>
                <span>One-time code</span>
                <input
                  autoComplete="one-time-code"
                  disabled={!canEdit || pending}
                  inputMode="numeric"
                  maxLength={8}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 8))}
                  placeholder="••••••"
                  value={otp}
                />
                <small>Digits only. Challenge is discarded after success or expiry.</small>
              </label>
              <div className={styles.actions}>
                <button
                  className="button primary"
                  disabled={!canEdit || pending || otp.length < 4 || !session.challengeId}
                  onClick={() => void run(() => submitMarshOtp(session.challengeId!, otp), "Marsh session is active.")}
                  type="button"
                >
                  <ShieldCheck size={16} aria-hidden="true" />
                  Verify OTP
                </button>
              </div>
            </div>
          ) : null}

          <div className={styles.actions}>
            <button
              className="button primary"
              disabled={!canEdit || pending || !session.credentialsConfigured}
              onClick={() => void connectMarsh()}
              type="button"
            >
              <KeyRound size={16} aria-hidden="true" />
              {sessionReady ? "Re-login" : pending || session.status === "connecting" ? "Connecting…" : "Connect Marsh"}
            </button>
            <button
              className="button secondary"
              disabled={!canEdit || pending}
              onClick={() => void run(() => ensureMarshSessionAction(), "Session checked.")}
              type="button"
            >
              <RefreshCw size={16} aria-hidden="true" />
              Test session
            </button>
            <button
              className="button secondary"
              disabled={!canEdit || pending || !sessionReady}
              onClick={() => {
                setError(null);
                setMessage(null);
                setPending(true);
                pushEvent("info", "Syncing Marsh ecards to Drive…");
                void syncMarshEcardsAction()
                  .then((result) => {
                    if (!result.ok) throw new Error(result.error || "Ecard sync failed");
                    const text = `Uploaded ${result.uploaded} card file(s); skipped ${result.skipped}.`;
                    setMessage(text);
                    pushEvent("good", text);
                  })
                  .catch((err: unknown) => {
                    const text = err instanceof Error ? err.message : "Ecard sync failed";
                    setError(text);
                    pushEvent("danger", text);
                  })
                  .finally(() => setPending(false));
              }}
              type="button"
            >
              <HardDrive size={16} aria-hidden="true" />
              Sync ecards → Drive
            </button>
          </div>
          {!canEdit ? <p className={styles.hint}>You have view-only access to Settings. Ask an editor to connect Marsh.</p> : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Automation scope</h2>
            <p className="subtle">
              HO and Last Mile EDSP enroll automatically. Amazon Now and Flipkart ODH stay on hold for Marsh. Delivery associates skip IDfy (Amazon BGC).
            </p>
          </div>
        </div>
        <ul className={styles.scopeList}>
          <li>
            <i>1</i>
            <div>
              <strong>On activation</strong>
              <span>Enqueue GMC + GPA enroll when PAN is valid and membership is not already Active.</span>
            </div>
          </li>
          <li>
            <i>2</i>
            <div>
              <strong>On offboarding</strong>
              <span>Enqueue termination with PAN and date of leaving for both policies.</span>
            </div>
          </li>
          <li>
            <i>3</i>
            <div>
              <strong>Background jobs</strong>
              <span>Cron processes queues. If OTP is needed again, jobs pause until you reconnect here.</span>
            </div>
          </li>
          <li>
            <i>4</i>
            <div>
              <strong>EDSP check with Nisar</strong>
              <span>If LSC already feeds Marsh for EDSP, keep EDSP on card-sync only.</span>
            </div>
          </li>
        </ul>
      </section>
    </div>
  );
}

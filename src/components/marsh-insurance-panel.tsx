"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ensureMarshSessionAction,
  getMarshSessionStatus,
  startMarshLogin,
  submitMarshOtp,
  syncMarshEcardsAction,
  type MarshSessionView,
} from "@/app/settings/marsh-actions";

type Props = {
  canEdit: boolean;
  initial: MarshSessionView;
};

function statusTone(status: string) {
  if (status === "active") return "good";
  if (status === "otp_required" || status === "connecting") return "warn";
  if (status === "failed" || status === "expired") return "danger";
  return "";
}

function mergeSession(prev: MarshSessionView, next: MarshSessionView): MarshSessionView {
  return {
    ...prev,
    ...next,
    driveConfigured: next.driveConfigured ?? prev.driveConfigured,
  };
}

export function MarshInsurancePanel({ canEdit, initial }: Props) {
  const [session, setSession] = useState(initial);
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refreshViaEvents = useCallback(() => {
    const timer = window.setInterval(() => {
      void getMarshSessionStatus()
        .then((json) => setSession((prev) => mergeSession(prev, json)))
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!["connecting", "otp_required"].includes(session.status)) return;
    return refreshViaEvents();
  }, [session.status, refreshViaEvents]);

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
        setSession((prev) => mergeSession(prev, result as MarshSessionView));
        const failed =
          ("ok" in result && result.ok === false) ||
          ["failed", "expired"].includes(String(result.status));
        if (failed) {
          setError(result.lastError || "Marsh session action failed.");
          return;
        }
      }
      if ("error" in result && result.error) {
        setError(String(result.error));
        return;
      }
      setMessage(okMessage);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="settings-stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Marsh / Qover session</h2>
            <p className="subtle">
              Portal email and password stay on the worker. Connect once, enter the email OTP here, and jobs reuse the cookie until it expires.
            </p>
          </div>
          <span className={`status-pill ${statusTone(session.status)}`}>{session.status.replaceAll("_", " ")}</span>
        </div>

        <dl className="details-grid" style={{ padding: "0 20px 16px" }}>
          <div>
            <dt>Credentials on worker</dt>
            <dd>{session.credentialsConfigured ? "Configured" : "Missing MARSH_PORTAL_* secrets"}</dd>
          </div>
          <div>
            <dt>Cookie</dt>
            <dd>
              {session.cookiePresent
                ? session.cookieAgeSeconds != null
                  ? `Present · ${Math.round(session.cookieAgeSeconds / 60)} min old`
                  : "Present"
                : "None"}
            </dd>
          </div>
          <div>
            <dt>Last update</dt>
            <dd>{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "—"}</dd>
          </div>
          <div>
            <dt>Drive sync</dt>
            <dd>{session.driveConfigured ? "Ready" : "Set GOOGLE_OAUTH_* and MARSH_DRIVE_FOLDER_ID"}</dd>
          </div>
        </dl>

        {session.lastError ? (
          <div className="alert danger">
            <strong>Last error</strong>
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

        {session.status === "otp_required" ? (
          <div className="form-grid" style={{ padding: "0 20px 16px" }}>
            <label>
              Email OTP
              <input
                autoComplete="one-time-code"
                disabled={!canEdit || pending}
                inputMode="numeric"
                maxLength={8}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder="6-digit code"
                value={otp}
              />
              <small className="field-hint">Code is never stored in logs. Challenge expires in about 10 minutes.</small>
            </label>
            <div className="form-actions">
              <button
                className="button primary"
                disabled={!canEdit || pending || otp.length < 4 || !session.challengeId}
                onClick={() => void run(() => submitMarshOtp(session.challengeId!, otp), "Marsh session is active.")}
                type="button"
              >
                Verify OTP
              </button>
            </div>
          </div>
        ) : null}

        <div className="form-actions" style={{ padding: "0 20px 20px" }}>
          <button
            className="button primary"
            disabled={!canEdit || pending || !session.credentialsConfigured}
            onClick={() => void run(() => startMarshLogin(), "Login started — check OTP if prompted.")}
            type="button"
          >
            {session.status === "active" ? "Re-login" : "Connect Marsh"}
          </button>
          <button
            className="button secondary"
            disabled={!canEdit || pending}
            onClick={() => void run(() => ensureMarshSessionAction(), "Session checked.")}
            type="button"
          >
            Test session
          </button>
          <button
            className="button secondary"
            disabled={!canEdit || pending || session.status !== "active"}
            onClick={() => {
              setError(null);
              setMessage(null);
              setPending(true);
              void syncMarshEcardsAction()
                .then((result) => {
                  if (!result.ok) throw new Error(result.error || "Ecard sync failed");
                  setMessage(`Uploaded ${result.uploaded} card file(s); skipped ${result.skipped}.`);
                })
                .catch((err: unknown) => setError(err instanceof Error ? err.message : "Ecard sync failed"))
                .finally(() => setPending(false));
            }}
            type="button"
          >
            Sync ecards → Drive
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Automation scope</h2>
            <p className="subtle">
              HO employees and Last Mile EDSP. Amazon Now / Flipkart ODH are held for Marsh. DAs skip IDfy (Amazon BGC).
            </p>
          </div>
        </div>
        <ul className="subtle" style={{ padding: "0 20px 20px", margin: 0, lineHeight: 1.6 }}>
          <li>Activation enqueues GMC + GPA enroll when PAN is valid and membership is not already Active.</li>
          <li>Offboarding enqueues termination (PAN + date of leaving).</li>
          <li>Cron processes queues; if the session needs OTP, jobs pause until you reconnect here.</li>
          <li>Confirm with Nisar whether LSC already feeds Marsh for EDSP — if yes, EDSP is card-sync only.</li>
        </ul>
      </section>
    </div>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { previewStationAuditEmail, retryStationAuditEmail } from "./actions";

export function AuditEmailDelivery({
  auditId,
  sent,
}: {
  auditId: string;
  sent: boolean;
}) {
  const router = useRouter();
  const [recipients, setRecipients] = useState<{
    to: string[];
    cc: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function preview() {
    setBusy(true);
    setNotice("");
    try {
      setRecipients(await previewStationAuditEmail(auditId));
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Recipients could not be loaded.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
    setNotice("");
    try {
      const result = await retryStationAuditEmail(auditId, sent);
      setNotice(result.message);
      if (result.ok) {
        setRecipients(null);
        router.refresh();
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Email could not be sent.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      style={{
        flex: "1 1 100%",
        borderTop: "1px solid #e2e8f0",
        paddingTop: 10,
      }}
    >
      <button
        className="button secondary compact"
        disabled={busy}
        onClick={preview}
      >
        {busy
          ? "Please wait…"
          : sent
            ? "Review recipients / send again"
            : "Review recipients / send report"}
      </button>
      {recipients && (
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
          <strong>Current recipients from Audit Master and People</strong>
          <div>
            To: {recipients.to.join(", ") || "No station recipient configured"}
          </div>
          <div>CC: {recipients.cc.join(", ") || "None configured"}</div>
          <small>
            The illustrated PDF is attached. Station responses should be
            recorded in OpsPulse using the email link.
          </small>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              className="button compact"
              disabled={busy || !recipients.to.length}
              onClick={send}
            >
              {sent ? "Send report again" : "Send report email"}
            </button>
            <button
              className="button secondary compact"
              disabled={busy}
              onClick={() => setRecipients(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

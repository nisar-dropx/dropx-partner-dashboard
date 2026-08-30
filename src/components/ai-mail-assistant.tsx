"use client";

import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";

type DraftResponse = { subject?: string; body?: string; error?: string; provider?: string };

export function AiMailAssistant({ stationAddressId }: { stationAddressId: string }) {
  const rootRef = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function generate() {
    const form = rootRef.current?.closest("form");
    if (!form) return;
    const purpose = (rootRef.current?.querySelector<HTMLTextAreaElement>("[name=ai_purpose]")?.value ?? "").trim();
    if (!purpose) {
      setError("Tell AI what the email should achieve.");
      return;
    }
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/ops-pulse/mail/compose-ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stationAddressId,
          purpose,
          action: rootRef.current?.querySelector<HTMLSelectElement>("[name=ai_action]")?.value ?? "write",
          tone: rootRef.current?.querySelector<HTMLSelectElement>("[name=ai_tone]")?.value ?? "formal",
          length: rootRef.current?.querySelector<HTMLSelectElement>("[name=ai_length]")?.value ?? "concise",
          recipients: value("to"),
          currentSubject: value("subject"),
          currentBody: value("body")
        })
      });
      const payload = await response.json().catch(() => ({})) as DraftResponse;
      if (!response.ok) throw new Error(payload.error || "AI draft generation failed.");
      const subject = form.elements.namedItem("subject") as HTMLInputElement | null;
      const body = form.elements.namedItem("body") as HTMLTextAreaElement | null;
      if (subject && payload.subject) subject.value = payload.subject;
      if (body && payload.body) body.value = payload.body;
      subject?.dispatchEvent(new Event("input", { bubbles: true }));
      body?.dispatchEvent(new Event("input", { bubbles: true }));
      setNotice(`Draft inserted${payload.provider ? ` using ${payload.provider}` : ""}. Review it before sending.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI draft generation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="ops-mail-ai-compose" ref={rootRef}>
      <summary><Sparkles size={15} /><span><strong>AI compose</strong><small>Write, improve or shorten this email</small></span></summary>
      <div>
        <label>What should this email achieve?<textarea maxLength={2000} name="ai_purpose" placeholder="Example: Ask the client to confirm tomorrow’s revised pickup timing and mention that service will continue without EDD impact." /></label>
        <div className="ops-mail-ai-options">
          <label>Action<select defaultValue="write" name="ai_action"><option value="write">Write new</option><option value="improve">Improve current draft</option><option value="reply">Draft a reply</option><option value="shorten">Make concise</option></select></label>
          <label>Tone<select defaultValue="formal" name="ai_tone"><option value="formal">Formal</option><option value="direct">Direct</option><option value="warm">Warm</option><option value="firm">Firm</option><option value="apologetic">Apologetic</option></select></label>
          <label>Length<select defaultValue="concise" name="ai_length"><option value="concise">Concise</option><option value="standard">Standard</option><option value="detailed">Detailed</option></select></label>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="success">{notice}</p> : null}
        <button disabled={busy} onClick={generate} type="button"><Sparkles size={14} /> {busy ? "Generating…" : "Generate draft"}</button>
        <small>AI never sends automatically. Check names, dates and commitments before sending.</small>
      </div>
    </details>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";

export function ImproveRedisputeRemark({ month, caseKey, note, onUse, disabled }: {
  month: string; caseKey: string; note: string; onUse: (value: string) => void; disabled: boolean;
}) {
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<{ original: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setPreview(null);
    setError("");
    setWorking(false);
    return () => active.current?.abort();
  }, [note]);
  async function improve() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setWorking(true);
    setError("");
    setPreview(null);
    try {
      const res = await fetch("/api/ops-pulse/losses/improve-remark", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, case_key: caseKey, note }), signal: controller.signal
      });
      const result = await res.json();
      if (!res.ok) throw Error(result.error || "Please retry.");
      if (!controller.signal.aborted) setPreview({ original: note, text: result.suggestion });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Please retry.");
    } finally {
      if (!controller.signal.aborted) setWorking(false);
    }
  }
  return <div>
    <button type="button" disabled={disabled || working || !note.trim()} onClick={improve}>
      {working ? "Improving…" : "Improve text"}
    </button>
    {error && <p role="alert">{error}</p>}
    {preview && preview.original === note && <div aria-live="polite">
      <strong>Suggested wording</strong>
      <p style={{ whiteSpace: "pre-wrap" }}>{preview.text}</p>
      <button type="button" disabled={disabled} onClick={() => onUse(preview.text)}>Use suggestion</button>{" "}
      <button type="button" onClick={() => setPreview(null)}>Keep original</button>
    </div>}
  </div>;
}

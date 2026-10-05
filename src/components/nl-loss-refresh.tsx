"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./nl-loss.module.css";
export function NlLossRefresh() {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function refresh() {
    setBusy(true);
    setMessage(
      "Checking Cloak’s available months. This can take a few minutes.",
    );
    try {
      const r = await fetch("/api/ops-pulse/losses/sync", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw Error(j.error);
      setMessage("Cloak data refreshed.");
      router.refresh();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Refresh could not complete.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        className={styles.button}
        onClick={() => void refresh()}
        disabled={busy}
      >
        {busy ? "Refreshing Cloak…" : "Refresh Cloak now"}
      </button>
      {message ? <span role="status">{message}</span> : null}
    </div>
  );
}

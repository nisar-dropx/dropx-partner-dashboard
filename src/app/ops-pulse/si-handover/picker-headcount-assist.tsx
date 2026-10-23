"use client";

import { useEffect, useRef, useState } from "react";
import type { TaskAnswer } from "@/lib/ops-pulse/si-handover/model";
import styles from "./si-handover.module.css";

type Snapshot = {
  fullTime: number;
  partTime: number;
  punchedPickers: number;
  unmatchedAtStore?: number;
  nonPickerAtStore?: number;
  note: string;
  error?: string;
};

function emptyCounts(answer: TaskAnswer) {
  const emptyFt = !String(answer.numbers.pickers_ft ?? "").trim();
  const emptyPt = !String(answer.numbers.pickers_pt ?? "").trim();
  return emptyFt && emptyPt;
}

export function PickerHeadcountAssist({
  checklistId,
  answer,
  setAnswer,
  disabled,
}: {
  checklistId: string;
  answer: TaskAnswer;
  setAnswer: (a: TaskAnswer) => void;
  disabled: boolean;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const autoApplied = useRef(false);
  const answerRef = useRef(answer);
  answerRef.current = answer;

  const applySnapshot = (data: Snapshot, force: boolean) => {
    const current = answerRef.current;
    if (!force && !emptyCounts(current)) return false;
    setAnswer({
      ...current,
      outcome: current.outcome || "yes",
      numbers: {
        ...current.numbers,
        pickers_ft: String(data.fullTime),
        pickers_pt: String(data.partTime),
      },
    });
    return true;
  };

  const load = async (opts?: { apply?: boolean; force?: boolean }) => {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch(
        `/api/ops-pulse/si-handover/picker-headcount?checklistId=${encodeURIComponent(checklistId)}`,
      );
      const body = (await r.json()) as Snapshot & { error?: string };
      if (!r.ok) throw Error(body.error || "Unable to load punch headcount.");
      setSnap(body);
      if (opts?.apply) {
        applySnapshot(body, Boolean(opts.force));
        setMessage(
          opts.force
            ? `Updated from punches · ${body.fullTime} FT · ${body.partTime} PT`
            : body.note,
        );
      }
      return body;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to load punches.";
      setSnap(null);
      setMessage(msg);
      return null;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    autoApplied.current = false;
    (async () => {
      const data = await load();
      if (cancelled || !data || autoApplied.current || disabled) return;
      if (emptyCounts(answerRef.current)) {
        autoApplied.current = true;
        applySnapshot(data, true);
        setMessage(data.note);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Prefill once when the checklist opens with empty A1 counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checklistId]);

  const edgeBits = [
    snap?.unmatchedAtStore
      ? `${snap.unmatchedAtStore} unmatched`
      : null,
    snap?.nonPickerAtStore
      ? `${snap.nonPickerAtStore} not coded picker`
      : null,
  ].filter(Boolean);

  return (
    <div className={styles.punchAssist}>
      <div className={styles.punchAssistRow}>
        <span className={styles.punchAssistMeta}>
          {busy
            ? "Reading punches…"
            : snap
              ? `Punches · ${snap.fullTime} FT · ${snap.partTime} PT (${snap.punchedPickers} pickers)${
                  edgeBits.length ? ` · ${edgeBits.join(" · ")}` : ""
                }`
              : "Punch headcount unavailable"}
        </span>
        <button
          type="button"
          className={styles.btnTiny}
          disabled={disabled || busy}
          onClick={() => void load({ apply: true, force: true })}
          title="Replace FT/PT with punch counts. Edit afterward for unregistered or unpunched pickers."
        >
          {busy ? "…" : "Use punch counts"}
        </button>
      </div>
      {message ? <small className={styles.punchAssistNote}>{message}</small> : null}
      {!message && snap?.note ? (
        <small className={styles.punchAssistNote}>{snap.note}</small>
      ) : null}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { BellOff, BellRing, CheckCircle2, Clock, Loader2, Zap } from "lucide-react";
import type { DsMessagePolicyWithMeta } from "@/lib/ops-pulse/ds-message-policy-store";
import type { DsMessageFrequency, DsMessageUrgency } from "@/lib/ops-pulse/ds-message-policy";
import { saveDsMessagePolicyAction } from "./actions";
import s from "./ds-message-policies.module.css";

const URGENCIES: DsMessageUrgency[] = ["critical", "high", "normal", "info"];
const FREQUENCIES: DsMessageFrequency[] = ["immediate", "cooldown", "digest", "mute"];

const URGENCY_META: Record<DsMessageUrgency, { label: string; color: string }> = {
  critical: { label: "Critical", color: "#c0392b" },
  high: { label: "High", color: "#d97706" },
  normal: { label: "Normal", color: "#2563eb" },
  info: { label: "Info", color: "#667085" }
};

const FREQUENCY_META: Record<DsMessageFrequency, { label: string; icon: React.ReactNode; hint: string }> = {
  immediate: { label: "Immediate", icon: <Zap size={13} aria-hidden />, hint: "Send as soon as the condition triggers" },
  cooldown: { label: "Cooldown", icon: <Clock size={13} aria-hidden />, hint: "Rate-limited — repeat sends after the cooldown window" },
  digest: { label: "Digest", icon: <BellRing size={13} aria-hidden />, hint: "Bundle multiple events into a single message" },
  mute: { label: "Muted", icon: <BellOff size={13} aria-hidden />, hint: "Disabled — no messages sent for this type" }
};

type Draft = {
  urgency: DsMessageUrgency;
  frequency: DsMessageFrequency;
  cooldownMinutes: number;
  thresholdSeconds: string;
  enabled: boolean;
};

function toDraft(row: DsMessagePolicyWithMeta): Draft {
  return {
    urgency: row.urgency,
    frequency: row.frequency,
    cooldownMinutes: row.cooldownMinutes,
    thresholdSeconds: row.thresholdSeconds != null ? String(row.thresholdSeconds) : "",
    enabled: row.enabled
  };
}

function isDirty(draft: Draft, row: DsMessagePolicyWithMeta) {
  return (
    draft.urgency !== row.urgency ||
    draft.frequency !== row.frequency ||
    draft.cooldownMinutes !== row.cooldownMinutes ||
    draft.thresholdSeconds !== (row.thresholdSeconds != null ? String(row.thresholdSeconds) : "") ||
    draft.enabled !== row.enabled
  );
}

export function DsMessagePoliciesView({
  initialPolicies,
  canEdit
}: {
  initialPolicies: DsMessagePolicyWithMeta[];
  canEdit: boolean;
}) {
  const [policies, setPolicies] = useState(initialPolicies);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(initialPolicies.map((p) => [p.id, toDraft(p)]))
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function patch(id: string, change: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
  }

  function save(id: string) {
    const draft = drafts[id];
    if (!draft) return;
    startTransition(async () => {
      setNotice(null);
      setError(null);
      const threshold =
        draft.thresholdSeconds.trim() === "" ? null : Number(draft.thresholdSeconds);
      const result = await saveDsMessagePolicyAction({
        id,
        urgency: draft.urgency,
        frequency: draft.frequency,
        cooldownMinutes: draft.cooldownMinutes,
        thresholdSeconds: Number.isFinite(threshold) ? threshold : null,
        enabled: draft.enabled
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPolicies((rows) => rows.map((r) => (r.id === id ? result.policy : r)));
      setDrafts((prev) => ({ ...prev, [id]: toDraft(result.policy) }));
      setNotice(`${result.policy.label} saved (v${result.policy.version}).`);
    });
  }

  return (
    <div className={s.page}>
      {notice ? (
        <div className={s.notice} role="status">
          <CheckCircle2 size={14} aria-hidden />
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className={s.errorBanner} role="alert">
          {error}
        </div>
      ) : null}

      <div className={s.cards}>
        {policies.map((row) => {
              const draft = drafts[row.id] ?? toDraft(row);
              const dirty = canEdit && isDirty(draft, row);
              const freqMeta = FREQUENCY_META[draft.frequency];
              const urgMeta = URGENCY_META[draft.urgency];
              return (
                <article key={row.id} className={`${s.card} ${draft.enabled ? "" : s.muted}`} aria-label={row.label}>
                  <div className={s.cardTop}>
                    <div className={s.cardMeta}>
                      <span
                        className={s.urgencyDot}
                        style={{ background: urgMeta.color }}
                        title={`Urgency: ${urgMeta.label}`}
                        aria-label={`Urgency: ${urgMeta.label}`}
                      />
                      <strong className={s.cardLabel}>{row.label}</strong>
                      {!draft.enabled && (
                        <span className={s.mutedBadge}>
                          <BellOff size={10} aria-hidden /> Muted
                        </span>
                      )}
                    </div>
                    {canEdit ? (
                      <label className={s.toggle} title={draft.enabled ? "Disable this alert" : "Enable this alert"}>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={draft.enabled}
                          disabled={pending}
                          onChange={(e) => patch(row.id, { enabled: e.target.checked })}
                          aria-label={`${row.label} enabled`}
                        />
                        <span className={s.toggleTrack} />
                      </label>
                    ) : (
                      <span className={s.readonlyStatus}>{draft.enabled ? "On" : "Off"}</span>
                    )}
                  </div>

                  {row.description ? (
                    <p className={s.cardDesc}>{row.description}</p>
                  ) : null}

                  <div className={s.fields}>
                    <div className={s.field}>
                      <span className={s.fieldLabel}>Urgency</span>
                      {canEdit ? (
                        <select
                          className={s.select}
                          disabled={pending}
                          value={draft.urgency}
                          onChange={(e) => patch(row.id, { urgency: e.target.value as DsMessageUrgency })}
                          style={{ color: URGENCY_META[draft.urgency].color }}
                        >
                          {URGENCIES.map((u) => (
                            <option key={u} value={u}>{URGENCY_META[u].label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={s.fieldValue} style={{ color: urgMeta.color }}>{urgMeta.label}</span>
                      )}
                    </div>

                    <div className={s.field}>
                      <span className={s.fieldLabel}>Frequency</span>
                      {canEdit ? (
                        <select
                          className={s.select}
                          disabled={pending}
                          value={draft.frequency}
                          onChange={(e) => patch(row.id, { frequency: e.target.value as DsMessageFrequency })}
                        >
                          {FREQUENCIES.map((f) => (
                            <option key={f} value={f}>{FREQUENCY_META[f].label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={s.fieldValue}>{freqMeta.label}</span>
                      )}
                    </div>

                    {draft.frequency === "cooldown" || draft.frequency === "digest" ? (
                      <div className={s.field}>
                        <span className={s.fieldLabel}>Cooldown (min)</span>
                        {canEdit ? (
                          <input
                            type="number"
                            className={s.input}
                            min={0}
                            disabled={pending}
                            value={draft.cooldownMinutes}
                            onChange={(e) => patch(row.id, { cooldownMinutes: Number(e.target.value) })}
                          />
                        ) : (
                          <span className={s.fieldValue}>{draft.cooldownMinutes}m</span>
                        )}
                      </div>
                    ) : null}

                    {draft.thresholdSeconds !== "" || canEdit ? (
                      <div className={s.field}>
                        <span className={s.fieldLabel}>Threshold (s)</span>
                        {canEdit ? (
                          <input
                            type="number"
                            className={s.input}
                            min={0}
                            step={0.1}
                            disabled={pending}
                            placeholder="—"
                            value={draft.thresholdSeconds}
                            onChange={(e) => patch(row.id, { thresholdSeconds: e.target.value })}
                          />
                        ) : (
                          <span className={s.fieldValue}>{draft.thresholdSeconds ? `${draft.thresholdSeconds}s` : "—"}</span>
                        )}
                      </div>
                    ) : null}
                  </div>

                  <div className={s.cardFoot}>
                    <span className={`${s.freqTag} ${s[`freq_${draft.frequency}`]}`}>
                      {freqMeta.icon}
                      {freqMeta.label}
                    </span>
                    <span className={s.version}>v{row.version}</span>
                    {canEdit && dirty ? (
                      <button
                        type="button"
                        className={s.saveBtn}
                        disabled={pending}
                        onClick={() => save(row.id)}
                      >
                        {pending ? <Loader2 size={12} className={s.spin} aria-hidden /> : null}
                        Save
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
      </div>

      {policies.length === 0 ? (
        <div className={s.empty}>
          <BellRing size={28} aria-hidden />
          <strong>No message policies yet</strong>
          <span>Policies are seeded automatically when the first alert type is registered.</span>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import type { DsMessagePolicyWithMeta } from "@/lib/ops-pulse/ds-message-policy-store";
import type { DsMessageFrequency, DsMessageUrgency } from "@/lib/ops-pulse/ds-message-policy";
import { saveDsMessagePolicyAction } from "./actions";
import s from "../site-summary/ds-ops.module.css";

const URGENCIES: DsMessageUrgency[] = ["critical", "high", "normal", "info"];
const FREQUENCIES: DsMessageFrequency[] = ["immediate", "cooldown", "digest", "mute"];

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

  function patch(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
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
    <div className={s.report}>
      {notice ? <p className="subtle">{notice}</p> : null}
      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">{error}</div>
        </section>
      ) : null}
      <section className="panel">
        <div className="panel-body" style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Message type</th>
                <th>Urgency</th>
                <th>Frequency</th>
                <th>Cooldown (min)</th>
                <th>Threshold (s)</th>
                <th>Enabled</th>
                <th>Ver.</th>
                {canEdit ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {policies.map((row) => {
                const draft = drafts[row.id] ?? toDraft(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.label}</strong>
                      <div className="subtle" style={{ fontSize: 11 }}>
                        {row.messageType}
                      </div>
                      {row.description ? (
                        <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
                          {row.description}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <select
                        disabled={!canEdit || pending}
                        value={draft.urgency}
                        onChange={(e) => patch(row.id, { urgency: e.target.value as DsMessageUrgency })}
                      >
                        {URGENCIES.map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        disabled={!canEdit || pending}
                        value={draft.frequency}
                        onChange={(e) => patch(row.id, { frequency: e.target.value as DsMessageFrequency })}
                      >
                        {FREQUENCIES.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        disabled={!canEdit || pending}
                        value={draft.cooldownMinutes}
                        onChange={(e) => patch(row.id, { cooldownMinutes: Number(e.target.value) })}
                        style={{ width: 72 }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        disabled={!canEdit || pending}
                        placeholder="—"
                        value={draft.thresholdSeconds}
                        onChange={(e) => patch(row.id, { thresholdSeconds: e.target.value })}
                        style={{ width: 80 }}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!canEdit || pending}
                        checked={draft.enabled}
                        onChange={(e) => patch(row.id, { enabled: e.target.checked })}
                      />
                    </td>
                    <td>{row.version}</td>
                    {canEdit ? (
                      <td>
                        <button type="button" className="button" disabled={pending} onClick={() => save(row.id)}>
                          Save
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
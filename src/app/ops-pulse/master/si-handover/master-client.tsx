"use client";

import Link from "next/link";
import { useState } from "react";
import {
  CLOCK_OUT_MODES,
  type Master,
  type Settings,
} from "@/lib/ops-pulse/si-handover/model";
import { saveSiHandoverMaster } from "../../si-handover/actions";
import styles from "../../si-handover/si-handover.module.css";

export function SiHandoverMasterClient({
  master,
  roles,
  models,
  editable,
}: {
  master: Master;
  roles: { id: string; name: string }[];
  models: { id: string; name: string }[];
  editable: boolean;
}) {
  const [settings, setSettings] = useState<Settings>(master.settings);
  const [version, setVersion] = useState(master.version);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const toggle = (key: "managerRoles" | "siRoles" | "modelIds", id: string) => {
    setSettings((s) => {
      const list = new Set(s[key]);
      if (list.has(id)) list.delete(id);
      else list.add(id);
      return { ...s, [key]: [...list] };
    });
  };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Ops Masters</p>
          <h1>Shift operations Master</h1>
          <p>
            Configure who can fill/accept, which store models are in scope, and
            how clock-out is enforced until handover is accepted.{" "}
            <Link href="/si-handover">Open workspace</Link>
          </p>
        </div>
      </header>
      {message ? <p className={styles.error}>{message}</p> : null}
      <div className={styles.masterGrid}>
        <section className={styles.masterCard}>
          <h2>Clock-out enforcement</h2>
          <p className={styles.meta}>
            Do not hardcode this in Connect. Flip the mode here when you are
            ready for hard attendance blocking.
          </p>
          {CLOCK_OUT_MODES.map((mode) => (
            <label key={mode.value} className={styles.modeOption}>
              <input
                type="radio"
                name="clockOutMode"
                disabled={!editable}
                checked={settings.clockOutMode === mode.value}
                onChange={() =>
                  setSettings((s) => ({ ...s, clockOutMode: mode.value }))
                }
              />
              <span>
                <strong>{mode.label}</strong>
                <small>{mode.detail}</small>
              </span>
            </label>
          ))}
        </section>

        <section className={styles.masterCard}>
          <h2>Escalation</h2>
          <div className={styles.row}>
            <label>
              Store Manager alert (minutes)
              <input
                type="number"
                min={5}
                max={1440}
                disabled={!editable}
                value={settings.escalateStoreMinutes}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    escalateStoreMinutes: Number(e.target.value),
                  }))
                }
              />
            </label>
            <label>
              Cluster Manager alert (minutes)
              <input
                type="number"
                min={5}
                max={2880}
                disabled={!editable}
                value={settings.escalateClusterMinutes}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    escalateClusterMinutes: Number(e.target.value),
                  }))
                }
              />
            </label>
          </div>
        </section>

        <section className={styles.masterCard}>
          <h2>Shift fill / cover roles</h2>
          <p className={styles.meta}>
            Who may start, fill, submit and accept Shift operations — including Store
            Managers / Store Incharges covering when an SI is absent. Empty = anyone
            with Shift operations add permission.
          </p>
          <div className={styles.roleList}>
            {roles.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={settings.siRoles.includes(r.id)}
                  onChange={() => toggle("siRoles", r.id)}
                />
                {r.name}
              </label>
            ))}
          </div>
        </section>

        <section className={styles.masterCard}>
          <h2>Manager roles</h2>
          <div className={styles.roleList}>
            {roles.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={settings.managerRoles.includes(r.id)}
                  onChange={() => toggle("managerRoles", r.id)}
                />
                {r.name}
              </label>
            ))}
          </div>
        </section>

        <section className={styles.masterCard}>
          <h2>Store models in scope</h2>
          <div className={styles.roleList}>
            {models.map((m) => (
              <label key={m.id}>
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={settings.modelIds.includes(m.id)}
                  onChange={() => toggle("modelIds", m.id)}
                />
                {m.name}
              </label>
            ))}
          </div>
        </section>

        <section className={styles.masterCard}>
          <h2>Hyderabad city match</h2>
          <p className={styles.meta}>
            Used for YMS (E3) mandatory rule. Comma-separated substrings.
          </p>
          <input
            disabled={!editable}
            value={settings.hyderabadCityMatch.join(", ")}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                hyderabadCityMatch: e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              }))
            }
          />
        </section>
      </div>

      {editable ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btn}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMessage("");
              const r = await saveSiHandoverMaster({
                version,
                template: master.template,
                settings,
              });
              setBusy(false);
              if (!r.ok) {
                setMessage(r.error || "Save failed.");
                return;
              }
              if (r.version) setVersion(r.version);
              setMessage("Saved.");
            }}
          >
            Save master settings
          </button>
        </div>
      ) : (
        <p className={styles.meta}>Read-only for your role.</p>
      )}
    </div>
  );
}

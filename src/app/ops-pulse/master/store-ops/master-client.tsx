"use client";

import Link from "next/link";
import { useState } from "react";
import {
  type Master,
  type Settings,
} from "@/lib/ops-pulse/store-ops/model";
import { saveStoreOpsMaster } from "../../store-ops/actions";
import styles from "../../si-handover/si-handover.module.css";

export function StoreOpsMasterClient({
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

  const toggle = (
    key: "managerRoles" | "fillerRoles" | "modelIds",
    id: string,
  ) => {
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
          <h1>Store operations Master</h1>
          <p>
            Configure who fills the daily Store Manager checklist, who can
            oversee it, and which store models are in scope. Submit seals the
            day — there is no accept / reject.{" "}
            <Link href="/store-ops">Open workspace</Link>
          </p>
        </div>
      </header>
      {message ? <p className={styles.error}>{message}</p> : null}
      <div className={styles.masterGrid}>
        <section className={styles.masterCard}>
          <h2>Filler roles</h2>
          <p className={styles.meta}>
            Empty = anyone with Store Operations add/edit can start and submit
            the day checklist.
          </p>
          <div className={styles.roleList}>
            {roles.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={settings.fillerRoles.includes(r.id)}
                  onChange={() => toggle("fillerRoles", r.id)}
                />
                {r.name}
              </label>
            ))}
          </div>
        </section>

        <section className={styles.masterCard}>
          <h2>Manager roles</h2>
          <p className={styles.meta}>
            Oversight + Activities report for store operations (no accept step).
          </p>
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
            Used for city-specific mandatory tasks. Comma-separated substrings.
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
              const r = await saveStoreOpsMaster({
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

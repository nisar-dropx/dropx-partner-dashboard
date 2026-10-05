"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type {
  RecoveryOutcome,
  LossSettings,
} from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";
export function NlRecoveryMaster({
  outcomes,
  settings,
  canEdit,
}: {
  outcomes: RecoveryOutcome[];
  settings: LossSettings | null;
  canEdit: boolean;
}) {
  const router = useRouter(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Partial<RecoveryOutcome> | null>(null);
  async function save(body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/ops-pulse/losses/master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw Error(j.error);
      setMessage("Master updated. Past recovery records are preserved.");
      setEditing(null);
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Ops Masters · Losses</span>
          <h1>Loss Recovery Master</h1>
          <p>
            Configure the source decisions, recovery actions and allocation
            experience.
          </p>
        </div>
        <Link href="/attendance/losses/nl" className={styles.button}>
          Open NL loss →
        </Link>
      </header>
      {message ? (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      ) : null}
      {settings ? (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Cloak source & allocation rules</h2>
          </div>
          <form
            className={styles.detail}
            key={settings.updated_at}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void save({
                kind: "settings",
                updated_at: settings.updated_at,
                recoverable_statuses: String(f.get("statuses")).split("\n"),
                allow_equal_split: f.has("equal"),
                allow_custom_split: f.has("custom"),
                include_inactive_people: f.has("inactive"),
                history_months: Number(f.get("history_months")),
              });
            }}
          >
            <fieldset className={styles.fieldset} disabled={!canEdit || busy}>
              <label>
                Final recoverable source statuses
                <textarea
                  name="statuses"
                  rows={3}
                  defaultValue={settings.recoverable_statuses.join("\n")}
                  required
                />
              </label>
              <p className={styles.hint}>
                One exact Cloak decision per line. Only matching source cases
                enter the NL recovery list and totals. Do not add unresolved or
                non-recoverable decisions.
              </p>
              <label>
                Historical months to refresh
                <input
                  name="history_months"
                  type="number"
                  min="1"
                  max="36"
                  defaultValue={settings.history_months}
                  required
                />
              </label>
              <p className={styles.hint}>
                Refresh the latest available Cloak months on each sync. Older
                imported months remain available.
              </p>
              <label className={styles.check}>
                <input
                  name="equal"
                  type="checkbox"
                  defaultChecked={settings.allow_equal_split}
                />
                Enable equal split
              </label>
              <label className={styles.check}>
                <input
                  name="custom"
                  type="checkbox"
                  defaultChecked={settings.allow_custom_split}
                />
                Enable individual amounts
              </label>
              <label className={styles.check}>
                <input
                  name="inactive"
                  type="checkbox"
                  defaultChecked={settings.include_inactive_people}
                />
                Include inactive / left people linked to the station
              </label>
              <button className={styles.primary}>Save rules</button>
            </fieldset>
          </form>
        </section>
      ) : (
        <p className={styles.notice}>
          No Cloak source is connected to this company.
        </p>
      )}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div>
            <h2>Recovery outcomes</h2>
            <p>
              Removal hides an option from new plans. Historical selections stay
              readable.
            </p>
          </div>
          {canEdit ? (
            <button
              className={styles.primary}
              onClick={() =>
                setEditing({
                  code: "",
                  label: "",
                  allocation_required: false,
                  remarks_required: true,
                  is_active: true,
                  sort_order: (outcomes.length + 1) * 10,
                })
              }
            >
              + Add outcome
            </button>
          ) : null}
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Employee allocation</th>
                <th>Remarks</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o) => (
                <tr key={o.code}>
                  <td>
                    <strong>{o.label}</strong>
                    <small>{o.code}</small>
                  </td>
                  <td>{o.allocation_required ? "Required" : "Not required"}</td>
                  <td>{o.remarks_required ? "Required" : "Optional"}</td>
                  <td>{o.is_active ? "Active" : "Removed"}</td>
                  <td>
                    <div className={styles.toolbar}>
                      {canEdit ? (
                        <>
                          <button
                            className={styles.button}
                            onClick={() => setEditing(o)}
                          >
                            Edit
                          </button>
                          <button
                            className={styles.button}
                            disabled={busy}
                            onClick={() =>
                              void save({ ...o, is_active: !o.is_active })
                            }
                          >
                            {o.is_active ? "Remove" : "Restore"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editing ? (
          <form
            className={styles.detail}
            onSubmit={(e) => {
              e.preventDefault();
              void save(editing);
            }}
          >
            <fieldset disabled={busy} className={styles.fieldset}>
              <h3>{editing.updated_at ? "Edit outcome" : "Add outcome"}</h3>
              <div className={styles.formGrid}>
                <label>
                  Code
                  <input
                    pattern="[a-z][a-z0-9_]{1,49}"
                    required
                    disabled={!!editing.updated_at}
                    value={editing.code || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, code: e.target.value })
                    }
                  />
                </label>
                <label>
                  Display label
                  <input
                    required
                    maxLength={80}
                    minLength={2}
                    value={editing.label || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, label: e.target.value })
                    }
                  />
                </label>
                <label>
                  Display order
                  <input
                    type="number"
                    value={editing.sort_order}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        sort_order: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={editing.allocation_required}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      allocation_required: e.target.checked,
                    })
                  }
                />
                Require employee allocation and full amount split
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={editing.remarks_required}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      remarks_required: e.target.checked,
                    })
                  }
                />
                Require remarks
              </label>
              <div className={styles.toolbar}>
                <button className={styles.primary}>Save outcome</button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        ) : null}
      </section>
    </main>
  );
}

"use client";
import { useState } from "react";
import Link from "next/link";
import {
  questions,
  type Master,
  type Question,
  type EvidenceRule,
} from "@/lib/ops-pulse/store-audits/model";
import { saveStoreAuditMaster } from "./actions";
import styles from "../../store-audits/store-audits.module.css";
const id = () => crypto.randomUUID();
const newQuestion = (): Question => ({
  id: id(),
  label: "New check",
  guidance: "",
  required: true,
  allowNA: true,
  evidence: { when: "gap", min: 1, max: 5 },
  responseEvidence: { when: "always", min: 1, max: 5 },
  action: "",
  hours: 48,
  severity: "normal",
});
function EvidenceEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: EvidenceRule;
  onChange: (v: EvidenceRule) => void;
}) {
  return (
    <fieldset className={styles.evidenceConfig}>
      <legend>{label}</legend>
      <label>
        When required
        <select
          value={value.when}
          onChange={(e) =>
            onChange({
              ...value,
              when: e.target.value as EvidenceRule["when"],
              min: e.target.value === "optional" ? 0 : Math.max(1, value.min),
            })
          }
        >
          <option value="always">Every applicable check</option>
          <option value="gap">When a gap is found</option>
          <option value="optional">Optional</option>
        </select>
      </label>
      <label>
        Minimum files
        <input
          type="number"
          min={value.when === "optional" ? 0 : 1}
          max={20}
          value={value.min}
          onChange={(e) => onChange({ ...value, min: Number(e.target.value) })}
        />
      </label>
      <label>
        Maximum files
        <input
          type="number"
          min={value.min}
          max={20}
          value={value.max}
          onChange={(e) => onChange({ ...value, max: Number(e.target.value) })}
        />
      </label>
    </fieldset>
  );
}
export function StoreAuditMaster({
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
  const [template, setTemplate] = useState(master.template),
    [settings, setSettings] = useState(master.settings),
    [version, setVersion] = useState(master.version),
    [selected, setSelected] = useState(master.template.sections[0]?.id),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const section = template.sections.find((s) => s.id === selected);
  const change = (t: typeof template) => {
    setTemplate(t);
    setDirty(true);
  };
  const updateSection = (patch: Partial<NonNullable<typeof section>>) =>
    change({
      ...template,
      sections: template.sections.map((s) =>
        s.id === selected ? { ...s, ...patch } : s,
      ),
    });
  const updateQ = (qid: string, patch: Partial<Question>) =>
    updateSection({
      questions: section!.questions.map((q) =>
        q.id === qid ? { ...q, ...patch } : q,
      ),
    });
  const toggle = (
    key: "managerRoles" | "responderRoles" | "modelIds",
    v: string,
  ) => {
    setSettings({
      ...settings,
      [key]: settings[key].includes(v)
        ? settings[key].filter((x) => x !== v)
        : [...settings[key], v],
    });
    setDirty(true);
  };
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>DARK STORE · MASTER</span>
          <h1>Store Audit Master</h1>
          <p>
            Configure the checklist, evidence and follow-up. Existing audits
            retain their saved version.
          </p>
        </div>
        <Link className={styles.button} href="/store-audits">
          Store audits →
        </Link>
      </header>
      <div className={styles.toolbar}>
        <span>
          <b>{template.sections.length}</b> sections ·{" "}
          <b>{questions(template).length}</b> checks · Version {version}
          {dirty ? " · Unsaved changes" : ""}
        </span>
        <button
          disabled={!editable || busy || !dirty}
          className={styles.primary}
          onClick={async () => {
            setBusy(true);
            const r = await saveStoreAuditMaster(version, template, settings);
            setMessage(r.message);
            if (r.ok) {
              setVersion(r.version);
              setDirty(false);
            }
            setBusy(false);
          }}
        >
          {busy ? "Saving…" : "Save master"}
        </button>
      </div>
      {message && (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      )}
      <fieldset disabled={!editable || busy} className={styles.resetFieldset}>
        <details className={styles.card}>
          <summary>
            Programme settings · roles, store models and completion email
          </summary>
          <div className={styles.formGrid}>
            <label>
              Checklist name
              <input
                value={template.name}
                onChange={(e) => change({ ...template, name: e.target.value })}
              />
            </label>
            <label>
              Description
              <textarea
                value={template.description}
                onChange={(e) =>
                  change({ ...template, description: e.target.value })
                }
              />
            </label>
          </div>
          <div className={styles.formGrid}>
            {(["managerRoles", "responderRoles", "modelIds"] as const).map(
              (key, i) => (
                <fieldset className={styles.choiceList} key={key}>
                  <legend>
                    {
                      [
                        "Leadership / auditors",
                        "Store response roles",
                        "Eligible operation models",
                      ][i]
                    }
                  </legend>
                  {(key === "modelIds" ? models : roles).map((r) => (
                    <label key={r.id}>
                      <input
                        type="checkbox"
                        checked={settings[key].includes(r.id)}
                        onChange={() => toggle(key, r.id)}
                      />
                      {r.name}
                    </label>
                  ))}
                </fieldset>
              ),
            )}
          </div>
          <p className={styles.muted}>
            Roles also need the Store Audits page permission. Users can work
            only within their assigned stores. Scheduled and in-progress audits
            stay private from store response roles.
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={settings.emailEnabled}
              onChange={(e) => {
                setSettings({ ...settings, emailEnabled: e.target.checked });
                setDirty(true);
              }}
            />
            Email the store after completion, with a PDF report
          </label>
          <p className={styles.muted}>
            To: store email from Location Master. Replies remain in the station
            audit email thread. No scheduling email is sent to the store.
          </p>
          <fieldset className={styles.choiceList}>
            <legend>Completion email CC</legend>
            {[
              ["people_reporting_chain", "People reporting chain"],
              ["company_owners", "Company owners"],
              ["cluster_manager_email", "Cluster manager"],
              ["ops_manager_email", "Operations manager"],
              ["station_manager_email", "Store manager"],
              ["finance_manager_email", "Finance manager"],
            ].map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={settings.ccRules.includes(key)}
                  onChange={() => {
                    setSettings({
                      ...settings,
                      ccRules: settings.ccRules.includes(key)
                        ? settings.ccRules.filter((x) => x !== key)
                        : [...settings.ccRules, key],
                    });
                    setDirty(true);
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
        </details>
        <div className={styles.editor}>
          <aside className={styles.sectionNav}>
            <h2>Sections</h2>
            {template.sections.map((s, i) => (
              <button
                type="button"
                key={s.id}
                aria-current={selected === s.id ? "step" : undefined}
                onClick={() => setSelected(s.id)}
              >
                {i + 1}. {s.name}
                <span>{s.questions.length} checks</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                const s = {
                  id: id(),
                  name: "New section",
                  guidance: "",
                  questions: [newQuestion()],
                };
                change({ ...template, sections: [...template.sections, s] });
                setSelected(s.id);
              }}
            >
              ＋ Add section
            </button>
          </aside>
          {section && (
            <div className={styles.card}>
              <div className={styles.toolbar}>
                <h2>Edit section</h2>
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => {
                    if (
                      confirm(
                        "Remove this section and its checks from future audits? Existing audits keep their copy.",
                      )
                    ) {
                      const next = template.sections.filter(
                        (s) => s.id !== section.id,
                      );
                      change({ ...template, sections: next });
                      setSelected(next[0]?.id);
                    }
                  }}
                >
                  Delete section
                </button>
              </div>
              <label>
                Section name
                <input
                  value={section.name}
                  onChange={(e) => updateSection({ name: e.target.value })}
                />
              </label>
              <label>
                Auditor guidance
                <textarea
                  value={section.guidance}
                  onChange={(e) => updateSection({ guidance: e.target.value })}
                />
              </label>
              {section.questions.map((q, i) => (
                <details
                  key={q.id}
                  className={styles.question}
                  open={q.label === "New check"}
                >
                  <summary>
                    <span>
                      {i + 1}. {q.label}
                    </span>
                    <small>
                      {q.evidence.when === "optional"
                        ? "Evidence optional"
                        : `${q.evidence.min}–${q.evidence.max} proof files`}{" "}
                      · {q.hours}h action target
                    </small>
                  </summary>
                  <div className={styles.questionBody}>
                    <label>
                      Question
                      <input
                        value={q.label}
                        onChange={(e) =>
                          updateQ(q.id, { label: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      What to check / evidence instructions
                      <textarea
                        value={q.guidance}
                        onChange={(e) =>
                          updateQ(q.id, { guidance: e.target.value })
                        }
                      />
                    </label>
                    <div className={styles.inline}>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={q.required}
                          onChange={(e) =>
                            updateQ(q.id, { required: e.target.checked })
                          }
                        />
                        Required answer
                      </label>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={q.allowNA}
                          onChange={(e) =>
                            updateQ(q.id, { allowNA: e.target.checked })
                          }
                        />
                        Allow N/A with explanation
                      </label>
                    </div>
                    <EvidenceEditor
                      label="Auditor evidence"
                      value={q.evidence}
                      onChange={(evidence) => updateQ(q.id, { evidence })}
                    />
                    <EvidenceEditor
                      label="Store closure evidence"
                      value={q.responseEvidence}
                      onChange={(responseEvidence) =>
                        updateQ(q.id, { responseEvidence })
                      }
                    />
                    <label>
                      Suggested corrective action
                      <textarea
                        value={q.action}
                        onChange={(e) =>
                          updateQ(q.id, { action: e.target.value })
                        }
                      />
                    </label>
                    <div className={styles.formGrid}>
                      <label>
                        Action due within (hours)
                        <input
                          type="number"
                          min="1"
                          max="2160"
                          value={q.hours}
                          onChange={(e) =>
                            updateQ(q.id, { hours: Number(e.target.value) })
                          }
                        />
                      </label>
                      <label>
                        Severity
                        <select
                          value={q.severity}
                          onChange={(e) =>
                            updateQ(q.id, {
                              severity: e.target.value as Question["severity"],
                            })
                          }
                        >
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                          <option value="critical">Critical</option>
                        </select>
                      </label>
                    </div>
                    <div className={styles.inline}>
                      <button
                        type="button"
                        disabled={!i}
                        onClick={() => {
                          const qs = [...section.questions];
                          [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]];
                          updateSection({ questions: qs });
                        }}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        disabled={i === section.questions.length - 1}
                        onClick={() => {
                          const qs = [...section.questions];
                          [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]];
                          updateSection({ questions: qs });
                        }}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        className={styles.danger}
                        onClick={() => {
                          if (confirm("Delete this check from future audits?"))
                            updateSection({
                              questions: section.questions.filter(
                                (x) => x.id !== q.id,
                              ),
                            });
                        }}
                      >
                        Delete question
                      </button>
                    </div>
                  </div>
                </details>
              ))}
              <button
                type="button"
                onClick={() =>
                  updateSection({
                    questions: [...section.questions, newQuestion()],
                  })
                }
              >
                ＋ Add question
              </button>
            </div>
          )}
        </div>
      </fieldset>
    </div>
  );
}

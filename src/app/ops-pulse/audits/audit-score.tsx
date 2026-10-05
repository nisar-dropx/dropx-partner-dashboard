"use client";
import { reviewStationAuditScore } from "./actions";
import { uploadAuditFiles } from "@/lib/ops-pulse/station-audit-upload";
import { useState } from "react";
import type {
  AuditAssessment,
  AuditScoreSnapshot,
} from "@/lib/ops-pulse/station-audit-scoring";
import type {
  AuditOption,
  StationAuditWorkspace,
} from "@/lib/ops-pulse/station-audits";
import styles from "./audit-workspace.module.css";
export function ResponsibilityAssessment({
  keys,
  initial,
  options,
  evidence,
  labels = {},
}: {
  labels?: Record<string, string>;
  keys: string[];
  initial?: Record<string, AuditAssessment>;
  options: AuditOption[];
  evidence: StationAuditWorkspace["evidence"];
}) {
  const [values, setValues] = useState<Record<string, AuditAssessment>>(
    initial || {},
  );
  if (!keys.length) return null;
  const update = (key: string, field: keyof AuditAssessment, value: string) =>
    setValues((old) => ({
      ...old,
      [key]: {
        ...(old[key] || { code: "pending", reason: "", evidenceId: "" }),
        [field]: value,
      },
    }));
  return (
    <section className={styles.section} style={{ marginTop: 12 }}>
      <div className={styles.sectionHeader}>
        Responsibility & score exclusions
        <span>{keys.length} differences to assess</span>
      </div>
      <div className={styles.sectionBody}>
        <p className={styles.checkHelp}>
          Score only what the station could control. Verify a prior missing scan
          or external cause against dated evidence. Pending investigation does
          not deduct points, but prevents a final rating. Findings still require
          a station response.
        </p>
        <input
          type="hidden"
          name="score_assessments"
          value={JSON.stringify(values)}
        />
        {keys.map((key) => {
          const v = values[key] || {
            code: "pending",
            reason: "",
            evidenceId: "",
          };
          const excluded =
            options.find((o) => o.code === v.code)?.metadata
              .exclude_from_score === true;
          return (
            <details className={styles.check} key={key} open>
              <summary>
                <strong>
                  {key === "cash" ? "COD difference" : labels[key] || key}
                </strong>
              </summary>
              <div className={styles.twoCol}>
                <label className={styles.inputLabel}>
                  Station responsibility
                  <select
                    value={v.code}
                    onChange={(e) => update(key, "code", e.target.value)}
                  >
                    {options
                      .filter(
                        (o) =>
                          !Array.isArray(o.metadata.applies_to) ||
                          o.metadata.applies_to.includes(
                            key === "cash"
                              ? "cash"
                              : key.startsWith("check:")
                                ? "check"
                                : "shipment",
                          ),
                      )
                      .map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.label}
                        </option>
                      ))}
                  </select>
                </label>
                <label className={styles.inputLabel}>
                  Reason / reference
                  <input
                    value={v.reason}
                    onChange={(e) => update(key, "reason", e.target.value)}
                    required={v.code !== "pending"}
                    placeholder="What happened, when it was reported, and why the station could or could not control it"
                  />
                </label>
              </div>
              {excluded && (
                <div className={styles.twoCol}>
                  <label className={styles.inputLabel}>
                    Verified proof already attached
                    <select
                      value={v.evidenceId}
                      onChange={(e) =>
                        update(key, "evidenceId", e.target.value)
                      }
                    >
                      <option value="">
                        Attach a new proof below, or select saved evidence
                      </option>
                      {evidence.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.file_name || e.caption || e.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.inputLabel}>
                    Attach dated supporting proof
                    <input
                      type="file"
                      name={`assessment_proof_${key}`}
                      accept="image/*,application/pdf"
                      required={!v.evidenceId}
                    />
                    <small>
                      Use the prior missing scan, incident acknowledgement or
                      ERP evidence. The report records this link.
                    </small>
                  </label>
                </div>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}
export function AuditScore({
  snapshot,
  evidence = [],
  responses = [],
}: {
  snapshot: AuditScoreSnapshot;
  evidence?: StationAuditWorkspace["evidence"];
  responses?: StationAuditWorkspace["responses"];
}) {
  return (
    <section className={styles.scoreReport}>
      <div className={styles.scoreHeadline}>
        <div>
          <small>PHYSICAL STATION AUDIT</small>
          <h2>
            {snapshot.percentage == null
              ? "Not scored"
              : `${snapshot.percentage}%`}{" "}
            <span>{snapshot.rating}</span>
          </h2>
          <p>
            {snapshot.provisional
              ? "Provisional · responsibility / scoring review pending. Do not use as a final R&R score."
              : "Assessed result · findings and corrective actions remain tracked separately."}
          </p>
        </div>
      </div>
      <p className={styles.checkHelp}>{snapshot.rules.formula}</p>
      {snapshot.sections.map((s) => (
        <details className={styles.scoreArea} key={s.id}>
          <summary>
            <span>
              {s.name}
              <small>
                Weight {s.weight}% · contributes {s.contribution} points
              </small>
            </span>
            <strong>{s.percentage == null ? "N/A" : `${s.percentage}%`}</strong>
          </summary>
          <div className={styles.scoreBar}>
            <span style={{ width: `${s.percentage || 0}%` }} />
          </div>
          {s.items.map((i) => {
            const response = responses.find(
              (r) => r.checklist_item_id === i.id,
            );
            return (
              <details className={styles.check} key={i.id}>
                <summary>
                  <strong>{i.label}</strong>
                  <span>{i.score == null ? "Excluded" : `${i.score}/100`}</span>
                </summary>
                <p>
                  {i.outcome} · check weight {i.weight}
                </p>
                <small>{i.reason}</small>
                {response?.remarks && (
                  <p>
                    <b>Observation:</b> {response.remarks}
                  </p>
                )}
                {(
                  (
                    response?.response_value as {
                      employees?: {
                        employee_code: string;
                        full_name: string;
                      }[];
                    }
                  )?.employees || []
                ).map((p) => (
                  <p key={p.employee_code}>
                    Custodian: {p.employee_code} · {p.full_name}
                  </p>
                ))}
                <div className={styles.scorePhotos}>
                  {evidence
                    .filter((e) => e.checklist_item_id === i.id)
                    .map((e) => (
                      <a
                        key={e.id}
                        href={`/api/ops-pulse/audits/evidence/${e.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          loading="lazy"
                          src={`/api/ops-pulse/audits/evidence/${e.id}`}
                          alt={e.caption || i.label}
                        />
                        <small>{e.file_name}</small>
                      </a>
                    ))}
                </div>
              </details>
            );
          })}
        </details>
      ))}
      {!!Object.keys(snapshot.assessments).length && (
        <details className={styles.scoreArea}>
          <summary>Responsibility decisions & evidence</summary>
          {Object.entries(snapshot.assessments).map(([key, a]) => (
            <div className={styles.check} key={key}>
              <strong>
                {key === "cash" ? "COD difference" : key} · {a.label}
              </strong>
              <p>{a.reason || "Investigation pending"}</p>
              <small>
                {a.pending
                  ? "Provisional; no deduction yet"
                  : a.excluded
                    ? "Verified exclusion; no score deduction"
                    : "Included in accuracy calculation"}
              </small>
              {a.evidenceId && (
                <p>
                  <a
                    href={`/api/ops-pulse/audits/evidence/${a.evidenceId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View supporting evidence →
                  </a>
                </p>
              )}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

export function ScoreReview({
  audit,
  options,
  evidence,
}: {
  audit: {
    id: string;
    updated_at: string;
    score_snapshot?: AuditScoreSnapshot | null;
  };
  options: AuditOption[];
  evidence: StationAuditWorkspace["evidence"];
}) {
  const [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  if (
    !audit.score_snapshot?.inputs ||
    !Object.keys(audit.score_snapshot.assessments).length
  )
    return null;
  return (
    <details className={styles.section}>
      <summary>
        Review station responsibility
        <span>Authorized manager · retains original weights</span>
      </summary>
      <form
        className={styles.sectionBody}
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setPending(true);
          try {
            await uploadAuditFiles(data);
            const result = await reviewStationAuditScore(data);
            setNotice(result.message);
          } catch (error) {
            setNotice(
              error instanceof Error ? error.message : "Unable to save review",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <input name="audit_id" type="hidden" value={audit.id} />
        <input name="updated_at" type="hidden" value={audit.updated_at} />
        <ResponsibilityAssessment
          keys={Object.keys(audit.score_snapshot.assessments)}
          initial={audit.score_snapshot.assessments}
          options={audit.score_snapshot.inputs.options
            .filter((o) => "exclude_from_score" in o.metadata)
            .map((o) => ({
              ...o,
              id: o.code,
              option_group: "audit_responsibility",
              description: null,
              sort_order: 0,
              is_active: true,
            }))}
          evidence={evidence}
          labels={Object.fromEntries(
            audit.score_snapshot.sections.flatMap((s) =>
              s.items.map((i) => [`check:${i.id}`, i.label]),
            ),
          )}
        />
        <p className={styles.checkHelp}>
          Verify the station response and dated proof before approving an
          exclusion. This updates the score and report email; the original
          result stays in audit history.
        </p>
        <button className="button" disabled={pending}>
          {pending ? "Saving review…" : "Save responsibility review"}
        </button>
        <p role="status">{notice}</p>
      </form>
    </details>
  );
}

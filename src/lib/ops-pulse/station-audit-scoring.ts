/** Server and preview share the arithmetic; persisted reports retain these inputs. */
export type AuditAssessment = {
  code: string;
  reason: string;
  evidenceId: string;
};
type Option = {
  code: string;
  label: string;
  metadata: Record<string, unknown>;
};
type Item = {
  id: string;
  section_id: string | null;
  label: string;
  score_weight?: number;
  score_source?: string;
  response_options: {
    value: string;
    label: string;
    score?: number | null;
    is_compliant?: boolean | null;
  }[];
};
export type AuditScoreSnapshot = {
  inputs?: AuditScoreInput;
  version: 1;
  percentage: number | null;
  rating: string;
  provisional: boolean;
  sections: {
    id: string;
    name: string;
    weight: number;
    percentage: number | null;
    contribution: number;
    items: {
      id: string;
      label: string;
      outcome: string;
      score: number | null;
      weight: number;
      reason: string;
    }[];
  }[];
  assessments: Record<
    string,
    AuditAssessment & { label: string; excluded: boolean; pending: boolean }
  >;
  rules: { bands: { label: string; minimum: number }[]; formula: string };
  assessedAt: string;
};
const round = (n: number) => Math.round(n * 100) / 100;
export type AuditScoreInput = {
  sections: { id: string; name: string; score_weight?: number }[];
  items: Item[];
  responses: Record<string, string>;
  options: Option[];
  expectedCash: number;
  actualCash: number;
  expectedTids: string[];
  scannedTids: string[];
  assessments: Record<string, AuditAssessment>;
  evidenceIds: string[];
};
/** Human label for cash / checklist / TID responsibility keys shown in validation. */
export function auditAssessmentSubject(
  key: string,
  items: { id: string; label: string }[] = [],
) {
  if (key === "cash") return "COD difference";
  if (key.startsWith("check:")) {
    const id = key.slice("check:".length);
    return items.find((item) => item.id === id)?.label || "checklist finding";
  }
  return `tracking ID ${key}`;
}
export type AuditResponsibilityIssue = {
  key: string;
  fieldName: string;
  message: string;
};
export class AuditResponsibilityError extends Error {
  issue: AuditResponsibilityIssue;
  constructor(issue: AuditResponsibilityIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

/** Match the same scored checklist outcomes in the editor and the scorer. */
export function auditCheckHasScoreDifference(item: Item, response: string) {
  const score = item.response_options.find((o) => o.value === response)?.score;
  return (
    item.score_source !== "cash_match" &&
    item.score_source !== "shipment_match" &&
    score != null &&
    score < 100
  );
}

/** Keep a retained assessment editable after a better, but still scored, outcome. */
export function auditCheckNeedsResponsibility(
  item: Item,
  response: string,
  hasAssessment = false,
) {
  return (
    auditCheckHasScoreDifference(item, response) &&
    (hasAssessment ||
      item.response_options.find((o) => o.value === response)?.is_compliant ===
        false)
  );
}

export function auditResponsibilityIssue(
  key: string,
  value: AuditAssessment,
  options: Option[],
  evidenceIds: string[],
  label: string,
): AuditResponsibilityIssue | null {
  const issue = (field: keyof AuditAssessment, message: string) => ({
    key,
    fieldName: `assessment_${field}_${key}`,
    message,
  });
  const option = options.find(
    (o) => o.code === value.code && "exclude_from_score" in o.metadata,
  );
  if (!option)
    return issue(
      "code",
      `Choose a configured responsibility outcome for ${label}.`,
    );
  const scope =
    key === "cash" ? "cash" : key.startsWith("check:") ? "check" : "shipment";
  if (
    Array.isArray(option.metadata.applies_to) &&
    !option.metadata.applies_to.includes(scope)
  )
    return issue(
      "code",
      `This responsibility option does not apply to ${label}.`,
    );
  if (option.metadata.pending !== true && !value.reason.trim())
    return issue(
      "reason",
      `Add the responsibility reason for ${label} in Responsibility & score exclusions.`,
    );
  if (
    option.metadata.exclude_from_score === true &&
    !evidenceIds.includes(value.evidenceId)
  )
    return issue(
      "evidenceId",
      `Select saved proof for the exclusion: ${label}.`,
    );
  return null;
}

/** Runs before uploads; saved proof is still independently checked by the server. */
export function auditResponsibilityFormIssue(
  data: FormData,
  keys: string[],
  options: Option[],
  evidenceIds: string[],
  labels: Record<string, string>,
) {
  let assessments: Record<string, AuditAssessment>;
  try {
    assessments = JSON.parse(String(data.get("score_assessments") || "{}"));
    if (
      !assessments ||
      typeof assessments !== "object" ||
      Array.isArray(assessments)
    )
      throw new Error("Invalid responsibility assessment.");
  } catch {
    return {
      key: "",
      fieldName: "",
      message: "Invalid responsibility assessment.",
    };
  }
  for (const key of keys) {
    // An untouched checklist outcome keeps its configured score, as on the server.
    if (key.startsWith("check:") && !assessments[key]) continue;
    const value = assessments[key] || {
      code: "pending",
      reason: "",
      evidenceId: "",
    };
    const proof = data.get(`assessment_proof_${key}`);
    const hasNewProof = proof instanceof File && proof.size > 0;
    const issue = auditResponsibilityIssue(
      key,
      hasNewProof ? { ...value, evidenceId: "new-proof" } : value,
      options,
      hasNewProof ? [...evidenceIds, "new-proof"] : evidenceIds,
      labels[key] || auditAssessmentSubject(key),
    );
    if (issue) return issue;
  }
  return null;
}

export function calculateAuditScore(
  input: AuditScoreInput,
): AuditScoreSnapshot {
  const assessments: AuditScoreSnapshot["assessments"] = {};
  let provisional = false;
  const classify = (key: string) => {
    const value = input.assessments[key] || {
      code: "pending",
      reason: "",
      evidenceId: "",
    };
    const label = auditAssessmentSubject(key, input.items);
    const issue = auditResponsibilityIssue(
      key,
      value,
      input.options,
      input.evidenceIds,
      label,
    );
    if (issue) throw new AuditResponsibilityError(issue);
    const option = input.options.find(
      (o) => o.code === value.code && "exclude_from_score" in o.metadata,
    )!;
    const pending = option.metadata.pending === true;
    const excluded = option.metadata.exclude_from_score === true;
    assessments[key] = { ...value, label: option.label, excluded, pending };
    provisional ||= pending;
    return { excluded: excluded || pending, pending };
  };
  const cashDifference = Math.abs(input.actualCash - input.expectedCash);
  const cash = cashDifference ? classify("cash") : null;
  const expected = new Set(input.expectedTids),
    scanned = new Set(input.scannedTids);
  const missing = [...expected].filter((id) => !scanned.has(id)),
    excess = [...scanned].filter((id) => !expected.has(id));
  let chargeableMissing = 0,
    chargeableExcess = 0,
    excludedMissing = 0;
  for (const id of missing) {
    if (classify(id).excluded) excludedMissing++;
    else chargeableMissing++;
  }
  for (const id of excess) if (!classify(id).excluded) chargeableExcess++;
  const eligible = expected.size - excludedMissing + chargeableExcess;
  const shipmentScore = eligible
    ? Math.max(0, 100 * (1 - (chargeableMissing + chargeableExcess) / eligible))
    : missing.length || excess.length
      ? null
      : 100;
  const cashScore = cash?.excluded
    ? null
    : Math.max(
        0,
        100 *
          (1 -
            cashDifference / Math.max(input.expectedCash, input.actualCash, 1)),
      );
  const configuredWeight = input.sections.reduce(
    (n, s) => n + Number(s.score_weight || 0),
    0,
  );
  const sections = input.sections.map((section) => {
    const items = input.items
      .filter((i) => i.section_id === section.id)
      .map((item) => {
        const response = input.responses[item.id];
        const option = item.response_options.find((o) => o.value === response);
        let score: number | null = option?.score ?? null;
        let outcome = option?.label || (response ? response : "Not assessed");
        let reason =
          score == null
            ? "Not applicable or not assessed; excluded from weighted average."
            : "Configured outcome score.";
        if (item.score_source === "cash_match") {
          score = cashScore;
          outcome = cashDifference
            ? cash?.excluded
              ? "Excluded / pending responsibility"
              : "Cash variance"
            : "Cash reconciled";
          reason =
            "100 × (1 − absolute variance ÷ larger of expected and counted cash). Verified external differences are excluded.";
        } else if (item.score_source === "shipment_match") {
          score = shipmentScore;
          outcome = `${chargeableMissing} chargeable missing · ${chargeableExcess} chargeable excess`;
          reason = `Eligible TIDs: ${eligible}. 100 × (1 − chargeable differences ÷ eligible TIDs). Verified exclusions and pending attribution do not deduct points.`;
        } else if (!response || (score == null && response !== "na"))
          provisional = true;
        if (
          auditCheckHasScoreDifference(item, response) &&
          input.assessments[`check:${item.id}`]
        ) {
          const assessment = classify(`check:${item.id}`);
          if (assessment.excluded) {
            score = null;
            outcome += assessment.pending
              ? " - responsibility pending"
              : " - verified exclusion";
            reason =
              assessments[`check:${item.id}`].reason ||
              "Awaiting investigation";
          }
        }
        if (
          score != null &&
          (!Number.isFinite(score) || score < 0 || score > 100)
        )
          throw new Error(`Invalid configured score: ${item.label}.`);
        return {
          id: item.id,
          label: item.label,
          outcome,
          score: score == null ? null : round(score),
          weight: Number(item.score_weight ?? 1),
          reason,
        };
      });
    const applicable = items.filter((i) => i.score != null && i.weight > 0);
    const denominator = applicable.reduce((n, i) => n + i.weight, 0);
    const percentage = denominator
      ? applicable.reduce((n, i) => n + i.score! * i.weight, 0) / denominator
      : null;
    return {
      id: section.id,
      name: section.name,
      weight: configuredWeight
        ? round((Number(section.score_weight ?? 0) * 100) / configuredWeight)
        : 0,
      percentage: percentage == null ? null : round(percentage),
      contribution: 0,
      items,
    };
  });
  const totalWeight = sections
    .filter((s) => s.percentage != null)
    .reduce((n, s) => n + s.weight, 0);
  for (const s of sections)
    s.contribution =
      s.percentage != null && totalWeight
        ? round((s.percentage * s.weight) / totalWeight)
        : 0;
  const percentage = totalWeight
    ? round(
        sections.reduce((n, s) => n + (s.percentage ?? 0) * s.weight, 0) /
          totalWeight,
      )
    : null;
  const bands = input.options
    .filter((o) => typeof o.metadata.minimum_score === "number")
    .map((o) => ({ label: o.label, minimum: Number(o.metadata.minimum_score) }))
    .sort((a, b) => b.minimum - a.minimum);
  if (!bands.length || !bands.some((b) => b.minimum === 0))
    throw new Error(
      "Configure final score bands, including a zero-point band, in Audit Master.",
    );
  return {
    inputs: JSON.parse(JSON.stringify(input)),
    version: 1,
    percentage,
    rating:
      percentage == null
        ? "Not scored"
        : bands.find((b) => percentage >= b.minimum)?.label || "Not scored",
    provisional: provisional || percentage == null,
    sections,
    assessments,
    rules: {
      bands,
      formula:
        "Section = weighted mean of applicable check scores. Overall = section scores × section weights / applicable section weights. N/A and verified uncontrollable findings do not deduct points. Pending attribution prevents a final rating.",
    },
    assessedAt: new Date().toISOString(),
  };
}

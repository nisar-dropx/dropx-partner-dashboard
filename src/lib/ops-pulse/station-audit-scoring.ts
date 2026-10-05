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
  response_options: { value: string; label: string; score?: number | null }[];
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
    const option = input.options.find(
      (o) => o.code === value.code && "exclude_from_score" in o.metadata,
    );
    if (!option)
      throw new Error(`Choose a configured responsibility outcome for ${key}.`);
    const scope =
      key === "cash" ? "cash" : key.startsWith("check:") ? "check" : "shipment";
    if (
      Array.isArray(option.metadata.applies_to) &&
      !option.metadata.applies_to.includes(scope)
    )
      throw new Error(`This responsibility option does not apply to ${key}.`);
    const pending = option.metadata.pending === true;
    const excluded = option.metadata.exclude_from_score === true;
    if (!pending && !value.reason.trim())
      throw new Error(`Add the responsibility reason for ${key}.`);
    if (excluded && !input.evidenceIds.includes(value.evidenceId))
      throw new Error(`Select saved proof for the exclusion: ${key}.`);
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
          item.score_source !== "cash_match" &&
          item.score_source !== "shipment_match" &&
          response &&
          score != null &&
          score < 100 &&
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

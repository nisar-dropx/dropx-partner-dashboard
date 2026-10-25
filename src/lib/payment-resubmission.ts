/** Keep historical master values selectable instead of silently displaying a blank. */
export function resubmissionOptions(options: string | null, savedValue?: string | null) {
  const values = (options ?? "").split(",").map(value => value.trim()).filter(Boolean);
  return [...new Set(savedValue && !values.includes(savedValue) ? [savedValue, ...values] : values)];
}
export function isFixedReplacementQuestion(reasonKey: string | null | undefined, questionText: string, savedValue?: string | null) {
  return Boolean(reasonKey && savedValue && /reason.*(?:adhoc|ad hoc).*deployment|^deployment date$/i.test(questionText));
}
export function latestReturn<T extends { action: string | null; created_at: string }>(events: T[]) {
  return events.filter(event => String(event.action).toLowerCase() === "returned")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

/** Keep the current correction stage, but allow configured evidence from either stage.
 * A bill requested during expense review must not wait until payment processing. */
export function resubmissionQuestions<T extends { field_stage?: string | null; question_text?: string; answer_type: string; sort_order: number; is_required: boolean }>(questions: T[] | null | undefined, stage: "expense" | "payment"): T[] {
  const active = (questions ?? []).filter(question => Number(question.sort_order) > 0);
  const inStage = (question: T) => (question.field_stage === "payment" ? "payment" : "expense") === stage;
  const label = (question: T) => question.question_text?.trim().replace(/\s+/g, " ").toLowerCase();
  const stageFiles = new Set(active.filter(question => inStage(question) && question.answer_type === "file").map(label).filter(Boolean));
  return active
    .filter(question => inStage(question) || (question.answer_type === "file" && !stageFiles.has(label(question))))
    .map(question => inStage(question) ? question : { ...question, is_required: false })
    .sort((a, b) => a.sort_order - b.sort_order);
}

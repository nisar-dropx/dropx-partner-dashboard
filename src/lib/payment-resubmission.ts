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
export function resubmissionQuestions<T extends { field_stage?: string | null; answer_type: string; sort_order: number; is_required: boolean }>(questions: T[] | null | undefined, stage: "expense" | "payment"): T[] {
  return (questions ?? []).filter(question => Number(question.sort_order) > 0)
    .filter(question => (question.field_stage === "payment" ? "payment" : "expense") === stage || question.answer_type === "file")
    .map(question => (question.field_stage === "payment" ? "payment" : "expense") === stage ? question : { ...question, is_required: false })
    .sort((a, b) => a.sort_order - b.sort_order);
}

type PaymentTrackingAnswer = {
  answer_value: string | null;
  payment_head_questions?: { question_text: string; answer_type: string } | null;
};

/** Derive shipments from saved tracking IDs, including requests created before this display existed. */
export function paymentShipmentCount(answers: readonly PaymentTrackingAnswer[]): number | null {
  const trackingAnswers = answers.filter(({ payment_head_questions: question }) => isPaymentTrackingQuestion(question));
  if (!trackingAnswers.length) return null;

  const trackingIds = trackingAnswers.flatMap(({ answer_value }) =>
    parsePaymentTrackingIds(answer_value ?? "")
  );
  return new Set(trackingIds).size;
}

export function isPaymentTrackingQuestion(question?: { question_text: string; answer_type: string } | null) {
  if (!question || !['text', 'textarea'].includes(question.answer_type)) return false;
  const label = question.question_text.toLowerCase().replace(/['’]/g, '').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').replace(/[\s:*]+$/g, '').trim();
  return /^(?:shipment )?tracking (?:ids?|numbers?)$/.test(label);
}
export function parsePaymentTrackingIds(value: string): string[] {
  // Preserve numeric/alphanumeric carrier IDs and leading zeros without guessing fixed lengths.
  // Excel headings, names and standalone punctuation are not tracking IDs.
  return [...new Set(value.split(/[\s,;|]+/).map(id => id.trim()).filter(id => /^(?=.*\d)[a-z0-9][a-z0-9._/-]*$/i.test(id)))];
}

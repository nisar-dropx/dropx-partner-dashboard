type PaymentTrackingAnswer = {
  answer_value: string | null;
  payment_head_questions?: { question_text: string; answer_type: string } | null;
};

/** Derive shipments from saved tracking IDs, including requests created before this display existed. */
export function paymentShipmentCount(answers: readonly PaymentTrackingAnswer[]): number | null {
  const trackingAnswers = answers.filter(({ payment_head_questions: question }) => {
    if (!question || !["text", "textarea"].includes(question.answer_type)) return false;
    const label = question.question_text
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[_-]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[\s:*]+$/g, "")
      .trim();
    return /^(?:shipment )?tracking (?:ids?|numbers?)$/.test(label);
  });
  if (!trackingAnswers.length) return null;

  const trackingIds = trackingAnswers.flatMap(({ answer_value }) =>
    (answer_value ?? "").split(/[\s,;]+/).filter(Boolean)
  );
  return new Set(trackingIds).size;
}

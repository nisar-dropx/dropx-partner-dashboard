import test from "node:test";
import assert from "node:assert/strict";
import {
  paymentQuestionDateBounds,
  paymentQuestionDateBoundsForValue,
  validatePaymentQuestionDate,
} from "./payment-question-date-rules.ts";

const todayConfig = { answer_type: "date", date_rule: "today", question_text: "Deployment Date" };
const noonIst = (isoDate) => new Date(`${isoDate}T06:30:00.000Z`); // 12:00 Asia/Kolkata

test("today rule bounds are the India calendar day", () => {
  assert.deepEqual(paymentQuestionDateBounds(todayConfig, noonIst("2026-10-17")), {
    min: "2026-10-17",
    max: "2026-10-17",
    helper: "Current date only",
  });
});

test("resubmit bounds keep an older saved date selectable", () => {
  const bounds = paymentQuestionDateBoundsForValue(todayConfig, "2026-10-16", noonIst("2026-10-17"));
  assert.deepEqual(bounds, {
    min: "2026-10-16",
    max: "2026-10-17",
    helper: "Current date only; original date kept if unchanged",
  });
});

test("validate accepts unchanged saved date on a later day", () => {
  assert.doesNotThrow(() =>
    validatePaymentQuestionDate("2026-10-16", todayConfig, noonIst("2026-10-17"), {
      existingValue: "2026-10-16",
    })
  );
});

test("validate still rejects a changed date outside the current window", () => {
  assert.throws(
    () =>
      validatePaymentQuestionDate("2026-10-15", todayConfig, noonIst("2026-10-17"), {
        existingValue: "2026-10-16",
      }),
    /Deployment Date: Current date only/
  );
});

test("new requests without an existing value still require today", () => {
  assert.throws(
    () => validatePaymentQuestionDate("2026-10-16", todayConfig, noonIst("2026-10-17")),
    /Deployment Date: Current date only/
  );
  assert.doesNotThrow(() =>
    validatePaymentQuestionDate("2026-10-17", todayConfig, noonIst("2026-10-17"))
  );
});

test("trimmed existing value still counts as unchanged", () => {
  assert.doesNotThrow(() =>
    validatePaymentQuestionDate("2026-10-15", todayConfig, noonIst("2026-10-17"), {
      existingValue: " 2026-10-15 ",
    })
  );
});

test("multi-day gap: intermediate date is not allowed, today and original are", () => {
  assert.doesNotThrow(() =>
    validatePaymentQuestionDate("2026-10-15", todayConfig, noonIst("2026-10-17"), {
      existingValue: "2026-10-15",
    })
  );
  assert.doesNotThrow(() =>
    validatePaymentQuestionDate("2026-10-17", todayConfig, noonIst("2026-10-17"), {
      existingValue: "2026-10-15",
    })
  );
  assert.throws(
    () =>
      validatePaymentQuestionDate("2026-10-16", todayConfig, noonIst("2026-10-17"), {
        existingValue: "2026-10-15",
      }),
    /Deployment Date: Current date only/
  );
});

test("past-rule resubmit keeps the originally saved date after the window moves", () => {
  const pastConfig = { answer_type: "date", date_rule: "past", date_days: 2, question_text: "Work Date" };
  // On 17th, past-2 allows 15-16. Saved 14th is outside but unchanged on resubmit.
  assert.doesNotThrow(() =>
    validatePaymentQuestionDate("2026-10-14", pastConfig, noonIst("2026-10-17"), {
      existingValue: "2026-10-14",
    })
  );
  assert.throws(
    () =>
      validatePaymentQuestionDate("2026-10-13", pastConfig, noonIst("2026-10-17"), {
        existingValue: "2026-10-14",
      }),
    /Work Date: Past 2 days only/
  );
});

test("non-date questions and empty values are ignored", () => {
  assert.doesNotThrow(() =>
    validatePaymentQuestionDate("2026-10-16", { answer_type: "text", date_rule: "today" }, noonIst("2026-10-17"))
  );
  assert.doesNotThrow(() => validatePaymentQuestionDate(null, todayConfig, noonIst("2026-10-17")));
  assert.doesNotThrow(() => validatePaymentQuestionDate("", todayConfig, noonIst("2026-10-17")));
});

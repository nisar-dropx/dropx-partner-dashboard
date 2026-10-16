import test from "node:test";
import assert from "node:assert/strict";
import {
  composeFeedback,
  decideDelivery,
  dueReminderSteps,
  extractJsonText,
  isGroupJid,
  localClock,
  normalizeDays,
  normalizeTimeList,
  parseAnalysis,
  parseClockTime,
  randomDelaySeconds,
  renderTemplate,
  senderLabel,
  sniffImageType,
  truncateText
} from "./logic.ts";

test("local clock follows the configured zone across the UTC date line", () => {
  // 20:00 UTC on Tuesday is 01:30 on Wednesday in India.
  const clock = localClock(new Date("2026-10-13T20:00:00Z"), "Asia/Kolkata");
  assert.deepEqual(clock, { date: "2026-10-14", minutes: 90, weekday: 3 });
  // Midnight must be 0 minutes, not 24:00.
  assert.equal(localClock(new Date("2026-10-13T18:30:00Z"), "Asia/Kolkata").minutes, 0);
});

test("time lists are validated, padded, sorted and de-duplicated", () => {
  assert.deepEqual(normalizeTimeList("9:45, 09:00 09:45;18:30"), ["09:00", "09:45", "18:30"]);
  assert.deepEqual(normalizeTimeList(""), []);
  assert.throws(() => normalizeTimeList("25:00"), /not a valid time/);
  assert.throws(() => normalizeTimeList("9am"), /not a valid time/);
  assert.throws(() => normalizeTimeList("01:00 02:00 03:00 04:00 05:00 06:00 07:00"), /at most 6/);
  assert.equal(parseClockTime("23:59"), 1439);
  assert.equal(parseClockTime("24:00"), null);
  assert.deepEqual(normalizeDays(["1", "1", "7", "-1", "0", "x"]), [0, 1]);
});

test("reminders: due slots send once, stale slots are skipped, future slots wait", () => {
  const times = ["09:00", "09:30", "10:00"];
  assert.deepEqual(dueReminderSteps(times, 0, 8 * 60 + 59, 30), []);
  assert.deepEqual(dueReminderSteps(times, 0, 9 * 60 + 5, 30), [{ index: 0, action: "send" }]);
  // Already handled slot 0: nothing new until 09:30.
  assert.deepEqual(dueReminderSteps(times, 1, 9 * 60 + 20, 30), []);
  // Worker was down 09:00-09:45: only the latest fresh reminder goes out, never a burst.
  assert.deepEqual(dueReminderSteps(times, 0, 9 * 60 + 45, 30), [{ index: 0, action: "skip_stale" }, { index: 1, action: "send" }]);
  // Bot switched on at 15:00: every earlier slot is stale, nothing is sent.
  assert.deepEqual(dueReminderSteps(times, 0, 15 * 60, 30).map((step) => step.action), ["skip_stale", "skip_stale", "skip_stale"]);
  // Unsorted input and garbage entries do not break ordering.
  assert.deepEqual(dueReminderSteps(["10:00", "bad", "09:00"], 0, 9 * 60, 30), [{ index: 0, action: "send" }]);
});

test("templates fill known placeholders and keep unknown ones visible", () => {
  assert.equal(renderTemplate("Hi {group}, send *{report}* by {due_time}. {oops}", { group: "DS-1", report: "EOD", due_time: "10:00 AM" }), "Hi DS-1, send *EOD* by 10:00 AM. {oops}");
  assert.equal(renderTemplate("{GROUP}", { group: "x" }), "x");
  assert.equal(renderTemplate("a\n\n\n\nb", {}), "a\n\nb");
});

const candidates = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];

test("AI output is validated and never trusted blindly", () => {
  const good = parseAnalysis(JSON.stringify({
    is_report: true, matched_report_type_id: candidates[1], verdict: "fail", confidence: 1.7,
    checks: [{ rule: "Date is today", status: "fail", note: "Shows yesterday" }, { rule: "x", status: "weird", note: "" }, "junk"],
    extracted_summary: "EOD screen", feedback: "Please resend today's screenshot."
  }), candidates);
  assert.equal(good.verdict, "fail");
  assert.equal(good.confidence, 1, "confidence is clamped to 0-1");
  assert.equal(good.matched_report_type_id, candidates[1]);
  assert.deepEqual(good.checks.map((check) => check.status), ["fail", "unclear"], "unknown statuses become unclear, junk entries dropped");

  // An id the model invented is not accepted; with two candidates there is no safe default.
  assert.equal(parseAnalysis({ is_report: true, matched_report_type_id: "made-up", verdict: "pass", confidence: 0.9, checks: [], extracted_summary: "", feedback: "ok" }, candidates).matched_report_type_id, null);
  // With one candidate, a missing id resolves to it.
  assert.equal(parseAnalysis({ is_report: true, matched_report_type_id: null, verdict: "pass", confidence: 0.9, checks: [], extracted_summary: "", feedback: "ok" }, [candidates[0]]).matched_report_type_id, candidates[0]);
  // is_report false wins over a contradictory verdict.
  const meme = parseAnalysis({ is_report: false, matched_report_type_id: candidates[0], verdict: "pass", confidence: 0.99, checks: [], extracted_summary: "", feedback: "nice" }, candidates);
  assert.equal(meme.verdict, "not_report");
  assert.equal(meme.matched_report_type_id, null);
  // Extracted values are kept as bounded text; junk and empty entries are dropped, and a non-report keeps none.
  const fields = parseAnalysis({
    is_report: true, matched_report_type_id: candidates[0], verdict: "pass", confidence: 0.9, checks: [], extracted_summary: "", feedback: "ok",
    extracted_fields: [{ label: "Deposit date", value: "15-10-2026" }, { label: "Amount", value: "₹12,400" }, { label: "", value: "x" }, "junk", ...Array(30).fill({ label: "n", value: "1" })]
  }, candidates).extracted_fields;
  assert.deepEqual(fields.slice(0, 2), [{ label: "Deposit date", value: "15-10-2026" }, { label: "Amount", value: "₹12,400" }]);
  assert.ok(fields.length <= 20);
  assert.deepEqual(meme.extracted_fields, []);
  assert.deepEqual(parseAnalysis({ is_report: true, matched_report_type_id: null, verdict: "pass", confidence: 1, checks: [], extracted_summary: "", feedback: "ok" }, [candidates[0]]).extracted_fields, [], "a model that omits the field still parses");
  assert.throws(() => parseAnalysis("not json", candidates));
  assert.throws(() => parseAnalysis({ verdict: "great" }, candidates), /unknown verdict/);
  assert.throws(() => parseAnalysis([], candidates), /JSON object/);
});

test("delivery: memes are silent, doubtful results go to a person, confident ones may auto-send", () => {
  const base = { is_report: true, matched_report_type_id: candidates[0], verdict: "pass", confidence: 0.95, checks: [{ rule: "r", status: "pass", note: "" }], extracted_summary: "", feedback: "Looks good." };
  const auto = { approval_mode: "auto", auto_send_min_confidence: 0.85 };
  assert.equal(decideDelivery({ ...base, is_report: false, verdict: "not_report" }, auto), "silent");
  assert.equal(decideDelivery(base, auto), "auto_send");
  assert.equal(decideDelivery(base, { ...auto, approval_mode: "manual" }), "needs_approval");
  assert.equal(decideDelivery({ ...base, confidence: 0.8 }, auto), "needs_approval");
  assert.equal(decideDelivery({ ...base, verdict: "needs_review" }, auto), "needs_approval");
  assert.equal(decideDelivery({ ...base, checks: [{ rule: "r", status: "unclear", note: "" }] }, auto), "needs_approval");
  assert.equal(decideDelivery({ ...base, feedback: "  " }, auto), "needs_approval");
});

test("feedback message uses the configured layout and length limit", () => {
  const settings = { feedback_template: "*{report}* · {sender}\n{verdict_label}\n{feedback}", label_pass: "OK", label_fail: "FIX", label_review: "CHECK", max_feedback_chars: 40 };
  const text = composeFeedback(settings, { verdict: "fail", feedback: "Date is wrong, please resend today's screenshot.", report: "EOD", sender: "Ravi", group: "g", date: "15-10-2026" });
  assert.ok(text.startsWith("*EOD* · Ravi\nFIX\nDate"));
  assert.ok(text.length <= 40 && text.endsWith("…"));
  assert.equal(truncateText("short", 10), "short");
});

test("JSON is recovered from fenced or chatty model replies", () => {
  assert.equal(extractJsonText('{"a":1}'), '{"a":1}');
  assert.equal(extractJsonText('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonText('Here you go: {"a":{"b":2}} hope it helps'), '{"a":{"b":2}}');
  assert.equal(extractJsonText("no json"), "no json", "unusable text is passed through so validation rejects it");
});

test("small helpers", () => {
  assert.equal(isGroupJid("120363012345678901@g.us"), true);
  assert.equal(isGroupJid("919876543210@s.whatsapp.net"), false);
  assert.equal(senderLabel("", "919876543210:4@s.whatsapp.net"), "+919876543210");
  assert.equal(senderLabel(" Ravi ", "x"), "Ravi");
  assert.equal(senderLabel(null, null), "team");
  assert.equal(randomDelaySeconds(20, 90, () => 0), 20);
  assert.equal(randomDelaySeconds(20, 90, () => 1), 90);
  assert.equal(randomDelaySeconds(90, 20, () => 0.5), 55, "swapped bounds still work");
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), "image/png");
  assert.equal(sniffImageType(new TextEncoder().encode("RIFF1234WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageType(new TextEncoder().encode("%PDF-1.7")), null);
});

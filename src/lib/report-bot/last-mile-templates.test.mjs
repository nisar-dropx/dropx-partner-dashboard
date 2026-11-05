import test from "node:test";
import assert from "node:assert/strict";
import { LAST_MILE_HOURLY_REMINDERS, LAST_MILE_REPORT_TEMPLATES } from "./last-mile-templates.ts";

test("Last Mile templates cover every Station board tab plus EOD and station-type", () => {
  const slugs = LAST_MILE_REPORT_TEMPLATES.map((template) => template.slug).sort();
  assert.deepEqual(slugs, [
    "eod-closure",
    "station-board-ageing",
    "station-board-creturn",
    "station-board-dot",
    "station-board-dsr",
    "station-board-edd",
    "station-board-rts",
    "station-board-swa",
    "station-board-zero",
    "station-type-board"
  ]);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const template of LAST_MILE_REPORT_TEMPLATES) {
    assert.ok(template.rules.length >= 2, template.slug);
    assert.ok(template.schedule, template.slug);
    assert.ok(template.schedule.reminder_times.length > 0, template.slug);
  }
});

test("Station board schedules use hourly 09:00–21:00; EOD uses evening timed reminders", () => {
  assert.deepEqual(LAST_MILE_HOURLY_REMINDERS, [
    "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"
  ]);
  const eod = LAST_MILE_REPORT_TEMPLATES.find((template) => template.slug === "eod-closure");
  assert.equal(eod.schedule.schedule_kind, "timed");
  assert.deepEqual(eod.schedule.reminder_times, ["20:00", "20:30", "21:00"]);
  assert.equal(eod.schedule.stop_when_received, true);
  for (const template of LAST_MILE_REPORT_TEMPLATES.filter((row) => row.slug !== "eod-closure")) {
    assert.equal(template.schedule.schedule_kind, "interval", template.slug);
    assert.deepEqual(template.schedule.reminder_times, LAST_MILE_HOURLY_REMINDERS, template.slug);
    assert.equal(template.schedule.due_time, "21:00", template.slug);
    assert.equal(template.schedule.stop_when_received, false, template.slug);
  }
});

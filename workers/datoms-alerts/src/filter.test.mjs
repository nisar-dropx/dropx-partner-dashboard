import test from "node:test";
import assert from "node:assert/strict";
import {
  filterDatomsEvent,
  formatCaption,
  isViolationEvent,
  messageHasL2L3,
  parseDatomsEvent
} from "./filter.mjs";

test("isViolationEvent accepts type 0 and Violation tag", () => {
  assert.equal(isViolationEvent({ type: 0 }), true);
  assert.equal(isViolationEvent({ tags: ["Violation"] }), true);
  assert.equal(isViolationEvent({ tags: "alert,Violation" }), true);
  assert.equal(isViolationEvent({ type: 1, tags: ["info"] }), false);
});

test("messageHasL2L3 matches rule template and message", () => {
  assert.equal(messageHasL2L3({ rule_template_name: "Door Open L2" }), true);
  assert.equal(messageHasL2L3({ message: "Freezer L3 breach" }), true);
  assert.equal(messageHasL2L3({ view_name: "L1 only" }), false);
});

test("filter keeps L1 from alert_message and stores for OpsPulse", () => {
  const event = {
    type: 0,
    tags: ["Violation"],
    entity_id: "e-l1",
    generated_at: "2026-11-27T07:00:00.000Z",
    details: {
      site_name: "TTA5",
      station_name: "TTA5 Freezer room w/DS",
      alert_message: "TTA5 Freezer room w/DS : Door Open L1 for more than 10 Minutes"
    }
  };
  const alert = filterDatomsEvent(event);
  assert.ok(alert);
  assert.equal(alert.level, "L1");
  assert.equal(alert.station, "TTA5");
});

test("filter drops non-allowed stations", () => {
  const event = {
    type: 0,
    rule_template_name: "Door Open L2 Alert",
    message: "Door open",
    generated_at: "2026-11-25T09:34:00.000Z",
    entity_id: "e1",
    details: { site_name: "ZZ99 Site" }
  };
  assert.equal(filterDatomsEvent(event), null);
});

test("filter keeps allowed station from site_name", () => {
  const event = {
    type: 0,
    rule_template_name: "Door Open L2 Alert",
    message: "Door open for more than 20 Minutes",
    generated_at: "2026-11-25T09:34:00.000Z",
    entity_id: "e2",
    details: {
      site_name: "TTA5",
      asset_name: "TTA5 Freezer room w/DS",
      room_type: "Freezer Room"
    }
  };
  const alert = filterDatomsEvent(event);
  assert.ok(alert);
  assert.equal(alert.station, "TTA5");
  assert.equal(alert.level, "L2");
  assert.equal(alert.dedupeKey, "e2:2026-11-25T09:34:00.000Z:Door Open L2 Alert");
});

test("parse station prefix from message when site missing", () => {
  const event = {
    type: 0,
    view_name: "Temp L3",
    message: "TTB3 chiller high",
    entity_id: "e3",
    generated_at: 1732525200
  };
  const alert = parseDatomsEvent(event);
  assert.ok(alert);
  assert.equal(alert.station, "TTB3");
  assert.equal(alert.level, "L3");
});

test("HAR-shaped event: details.rule_template_name + station_name", () => {
  const event = {
    message: "TTA5 Freezer room w/DS : Door Open L2 for more than 20 Minutes ",
    entity_type: "thing",
    entity_id: 39372,
    generated_at: 1795599230,
    tags: ["Violation"],
    type: 0,
    details: {
      station_name: "TTA5 Freezer room w/DS",
      site_name: "TTA5",
      rule_template_name: "Door Open L2",
      view_name: "Door Open L2",
      rule: { rule_data: { thing_category: "Freezer Room", param_view_name: "Door Status" } }
    }
  };
  const alert = filterDatomsEvent(event);
  assert.ok(alert);
  assert.equal(alert.station, "TTA5");
  assert.equal(alert.level, "L2");
  assert.equal(alert.asset, "TTA5 Freezer room w/DS");
  assert.equal(alert.roomType, "Freezer Room");
});

test("filter keeps non-L Violation notifications as L1 info", () => {
  const event = {
    type: 0,
    tags: ["Violation"],
    entity_id: "e-cycle",
    generated_at: "2026-11-27T10:00:00.000Z",
    message: "TTB3 Cooling Cycle End",
    details: {
      site_name: "TTB3",
      station_name: "TTB3 Chiller Compressor",
      rule_template_name: "Cooling Cycle End",
      alert_message: "TTB3 Cooling Cycle End"
    }
  };
  const alert = filterDatomsEvent(event);
  assert.ok(alert);
  assert.equal(alert.level, "L1");
  assert.equal(alert.station, "TTB3");
  assert.match(alert.title, /Cooling Cycle End/i);
});

test("formatCaption matches WhatsApp layout", () => {
  const alert = {
    title: "Door Open L2 Alert",
    generatedAt: "2026-11-25T09:34:00.000Z",
    siteName: "TTA5",
    asset: "TTA5 Freezer room w/DS",
    roomType: "Freezer Room",
    alertText: "Door open for more than 20 Minutes"
  };
  const caption = formatCaption(alert, { timeZone: "UTC" });
  assert.match(caption, /^\*Door Open L2 Alert\*/);
  assert.match(caption, /Site: TTA5/);
  assert.match(caption, /Alert: Door open for more than 20 Minutes/);
});
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function alertSignature(station, redPixels, width, height) {
  const band = Math.round(redPixels / 25) * 25;
  const sizeBand = `${Math.round(width / 50) * 50}x${Math.round(height / 50) * 50}`;
  return createHash("sha1").update(`${station}|${band}|${sizeBand}`).digest("hex");
}

function clientRefFor(signature) {
  return `wsdesk_${signature.slice(0, 24)}`;
}

const CLIENT_REF = /^[A-Za-z0-9_-]{8,64}$/;

test("client_ref matches report-bot validateSend rules", () => {
  const ref = clientRefFor(alertSignature("TCD4_SS", 84, 1550, 830));
  assert.match(ref, CLIENT_REF);
  assert.ok(ref.length >= 8 && ref.length <= 64);
});

test("alert signature is stable across small red-pixel jitter", () => {
  // Same 25-pixel band and ~50px size band.
  const a = alertSignature("TCD4_SS", 84, 1550, 830);
  const b = alertSignature("TCD4_SS", 87, 1548, 829);
  assert.equal(a, b);
});

test("alert signature changes when station changes", () => {
  const a = alertSignature("TCD4_SS", 100, 1550, 830);
  const b = alertSignature("STORE_2", 100, 1550, 830);
  assert.notEqual(a, b);
});

test("too-small capture guard", () => {
  const tooSmall = (width, height) => width < 400 || height < 300;
  assert.equal(tooSmall(159, 27), true);
  assert.equal(tooSmall(1550, 830), false);
});

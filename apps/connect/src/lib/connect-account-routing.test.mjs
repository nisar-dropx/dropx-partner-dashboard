import assert from "node:assert/strict";
import test from "node:test";
import { connectAccountKey, connectAccountRoute, resolveConnectRouteAccount } from "./connect-account-routing.ts";

const manager = { id: "manager", companyId: "dropx", profileType: "user", reference: "DROPX500", isDefault: true };
const partner = { id: "partner", companyId: "dropx", profileType: "contractor", reference: "DROPX500" };
const accounts = [manager, partner];
const fromUrl = (url, rows = accounts) => {
  const query = new URL(url, "https://one.example").searchParams;
  return resolveConnectRouteAccount(rows, query.get("account") || "", query.get("id") || "");
};

test("switching roles with the same DropX ID survives navigation, reload and back", () => {
  const history = [manager, partner, manager, partner].map(account => connectAccountRoute("/dashboard", account));
  for (const [index, url] of history.entries()) assert.equal(fromUrl(url), index % 2 ? partner : manager);
  assert.equal(fromUrl(history[2]), manager);
  assert.equal(fromUrl(connectAccountRoute("/attendance", partner)), partner);
  assert.equal(fromUrl(history[1], [...accounts].reverse()), partner);
});
test("every profile type and company has an unambiguous route", () => {
  const rows = ["user", "employee", "contractor", "workforce", "field_executive", "vendor", "worker"].flatMap(profileType =>
    ["dropx", "other"].map(companyId => ({id:"same-record-id",companyId,profileType,reference:"SAME-ID"}))
  );
  for (const row of rows) assert.equal(fromUrl(connectAccountRoute("/profile", row), rows), row);
});
test("ambiguous legacy links require account selection, even with a saved default", () => {
  assert.equal(resolveConnectRouteAccount(accounts, "", "DROPX500"), null);
  assert.equal(resolveConnectRouteAccount(accounts, "", " dropx500 "), null);
});
test("unique readable IDs, ID-less accounts, and old account-key links remain supported", () => {
  assert.equal(resolveConnectRouteAccount([partner], "", "dropx500"), partner);
  assert.equal(resolveConnectRouteAccount(accounts, connectAccountKey(partner), ""), partner);
  const noReference = {...partner, reference:null};
  assert.equal(fromUrl(connectAccountRoute("/settings", noReference), [noReference]), noReference);
  assert.equal(resolveConnectRouteAccount([noReference], "", noReference.id), noReference);
});
test("ordinary sign-in respects saved defaults and single-account login", () => {
  assert.equal(resolveConnectRouteAccount(accounts, "", ""), manager);
  assert.equal(resolveConnectRouteAccount([partner], "", ""), partner);
  assert.equal(resolveConnectRouteAccount(accounts.map(row => ({...row,isDefault:false})), "", ""), null);
  assert.equal(resolveConnectRouteAccount([], "", ""), null);
});
test("unknown, removed, or other-user selectors cannot fall back to an authorized account", () => {
  assert.equal(resolveConnectRouteAccount(accounts, "other-user", "DROPX500"), null);
  assert.equal(resolveConnectRouteAccount([manager], connectAccountKey(partner), "DROPX500"), null);
  assert.equal(resolveConnectRouteAccount(accounts, "", "unknown"), null);
});

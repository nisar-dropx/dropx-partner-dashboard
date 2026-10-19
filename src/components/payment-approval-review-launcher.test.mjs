import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, launcher, route] = await Promise.all([
  readFile(new URL("../app/payments/approvals/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./payment-approval-review-launcher.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/payments/approvals/[requestId]/route.ts", import.meta.url), "utf8")
]);

test("payment approval review opens locally without navigating the server page", () => {
  assert.match(page, /<PaymentApprovalReviewLauncher/);
  assert.doesNotMatch(page, /pendingOverlay={`Opening/);
  assert.doesNotMatch(page, /target="_blank"/);
  assert.match(launcher, /setOpen\(true\)/);
  assert.match(launcher, /createPortal\(modal, document\.body\)/);
});

test("slow evidence is fetched separately from the fast decision shell", () => {
  assert.match(launcher, /fetch\(`\/api\/payments\/approvals\/\$\{encodeURIComponent\(summary\.id\)\}`/);
  assert.match(launcher, /You can approve, return, reject, or open another request now\./);
  assert.match(route, /export async function GET/);
  assert.match(route, /Promise\.all\(\[/);
});

test("attachments use an embedded viewer with an explicit full-size escape hatch", () => {
  assert.match(launcher, /<iframe className="payment-attachment-preview-frame"/);
  assert.match(launcher, />Open full size<\/a>/);
  assert.equal((launcher.match(/target="_blank"/g) ?? []).length, 1);
});

test("a decision releases the modal before the backend mutation completes", () => {
  const closeIndex = launcher.indexOf("setOpen(false);", launcher.indexOf("async function decide"));
  const requestIndex = launcher.indexOf("await fetch(", launcher.indexOf("async function decide"));
  assert.ok(closeIndex > -1);
  assert.ok(requestIndex > closeIndex);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /await approvePaymentRequest\(form\)/);
});

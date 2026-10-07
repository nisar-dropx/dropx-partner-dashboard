import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { extractWhatsAppTemplateVariables } from "./whatsapp-template.ts";

const require = createRequire(import.meta.url);
const filename = new URL("./workforce-payout-whatsapp.ts", import.meta.url);
const source = fs.readFileSync(filename, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const module = { exports: {} };
new Function("require", "module", "exports", output)((name) => {
  if (name === "@/lib/whatsapp-template") return { extractWhatsAppTemplateVariables };
  return require(name);
}, module, module.exports);
const api = module.exports;

const components = [
  { type: "BODY", text: "Hello {{1}}, your {{2}} for {{3}} is ready." },
  { type: "BUTTONS", buttons: [{ type: "URL", text: "View payout", url: "https://one.dropxlogistics.com/payments/{{1}}" }] }
];

test("renders configured header/body/button parameters in Meta order", () => {
  const values = api.workforcePayoutWhatsAppValues({
    snapshot: {
      run: { period_start: "2026-09-01", period_end: "2026-09-30" },
      item: { worker_name: "Nisar", dropx_id: "DF100", net_amount: 1234, work_days: 26 }
    },
    person: {},
    reviewUntil: "2026-10-10T12:00:00Z"
  });
  const result = api.buildWorkforcePayoutTemplateComponents(components, {
    "body.1": "full_name",
    "body.2": "payment_label",
    "body.3": "payout_period",
    "button.0.1": "dropx_id"
  }, values);
  assert.deepEqual(result[0], {
    type: "body",
    parameters: [
      { type: "text", text: "Nisar" },
      { type: "text", text: "Payment" },
      { type: "text", text: "01 Sept 2026 to 30 Sept 2026" }
    ]
  });
  assert.deepEqual(result[1], {
    type: "button",
    sub_type: "url",
    index: "0",
    parameters: [{ type: "text", text: "DF100" }]
  });
});

test("rejects incomplete and non-whitelisted mappings before delivery", () => {
  const values = api.workforcePayoutWhatsAppValues({ snapshot: {}, person: {}, reviewUntil: "2026-10-10" });
  assert.throws(
    () => api.buildWorkforcePayoutTemplateComponents(components, { "body.1": "full_name" }, values),
    /missing mappings/i
  );
  assert.throws(
    () => api.buildWorkforcePayoutTemplateComponents(components, {
      "body.1": "full_name",
      "body.2": "secret_column",
      "body.3": "payout_period",
      "button.0.1": "dropx_id"
    }, values),
    /unsupported variable mapping/i
  );
});

test("sends only the approved dynamic URL suffix to a WhatsApp button", () => {
  const values = api.workforcePayoutWhatsAppValues({ snapshot: {}, person: {}, reviewUntil: "2026-10-10" });
  const dynamicUrl = [{ type: "BUTTONS", buttons: [{ type: "URL", text: "View payout", url: "https://one.dropxlogistics.com/{{1}}" }] }];
  const result = api.buildWorkforcePayoutTemplateComponents(dynamicUrl, { "button.0.1": "payout_url" }, values);
  assert.equal(result[0].parameters[0].text, "payments?tab=payouts");
  assert.throws(
    () => api.buildWorkforcePayoutTemplateComponents(
      [{ type: "BUTTONS", buttons: [{ type: "URL", text: "View payout", url: "https://example.com/{{1}}" }] }],
      { "button.0.1": "payout_url" },
      values
    ),
    /does not match the approved WhatsApp button base URL/i
  );
});

test("builds a DropX One deep link for the exact worker payout month", () => {
  const values = api.workforcePayoutWhatsAppValues({
    snapshot: {
      run: { period_start: "2026-09-01", period_end: "2026-09-30" },
      item: { worker_name: "Nisar", dropx_id: "DF 100" }
    },
    person: {},
    reviewUntil: "2026-10-10"
  });
  const url = new URL(values.payout_url);
  assert.equal(url.origin, "https://one.dropxlogistics.com");
  assert.equal(url.pathname, "/payments");
  assert.equal(url.searchParams.get("tab"), "payouts");
  assert.equal(url.searchParams.get("payoutMonth"), "2026-09");
  assert.equal(url.searchParams.get("id"), "DF 100");
});

test("normalizes local and already-prefixed WhatsApp recipients", () => {
  assert.equal(api.normalizeWorkforceWhatsAppRecipient("98765 43210", "+91"), "919876543210");
  assert.equal(api.normalizeWorkforceWhatsAppRecipient("919876543210", "91"), "919876543210");
  assert.equal(api.normalizeWorkforceWhatsAppRecipient("123", "91"), null);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL("./assets.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("require", "exports", "module", code)((name) => {
  assert.equal(name, "server-only");
  return {};
}, module.exports, module);
const { loadAssetRegister } = module.exports;

test("populated asset register uses the attachment schema and preserves its display timestamp", async () => {
  const queries = [];
  const fixtures = {
    assets: [{ id: "asset-1", asset_type_id: "type-1", asset_code: "DXA-1", barcode_value: "DXA-1", ownership_type: "owned", condition: "good", created_at: "2026-10-06T10:00:00Z" }],
    asset_types: [{ id: "type-1", category_id: "category-1", name: "Scanner", code: "SCAN", asset_categories: { name: "Devices" } }],
    asset_attachments: [{ id: "attachment-1", asset_id: "asset-1", attachment_type: "invoice", file_name: "invoice.pdf", content_type: "application/pdf", storage_bucket: "asset-evidence", storage_path: "company-1/asset-1/invoice.pdf", created_at: "2026-10-06T11:00:00Z" }],
    asset_rental_terms: [], asset_events: [], asset_audit_items: [],
  };
  const db = {
    from(table) {
      const query = { table, select: "", orders: [], filters: [] };
      queries.push(query);
      const builder = {
        select(value) { query.select = value; return this; },
        eq(...args) { query.filters.push(args); return this; },
        in(...args) { query.filters.push(args); return this; },
        order(value) { query.orders.push(value); return this; },
        range() { return this; }, limit() { return this; },
        then(resolve, reject) {
          const invalid = table === "asset_attachments" && (query.select.includes("uploaded_at") || query.orders.includes("uploaded_at"));
          return Promise.resolve(invalid ? { data: null, error: { code: "42703", message: "column asset_attachments.uploaded_at does not exist" } } : { data: fixtures[table], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    storage: { from(bucket) {
      assert.equal(bucket, "asset-evidence");
      return { async createSignedUrl(path, duration) {
        assert.equal(path, "company-1/asset-1/invoice.pdf");
        assert.equal(duration, 3600);
        return { data: { signedUrl: "https://example.test/private-invoice" } };
      } };
    } },
  };
  const register = await loadAssetRegister({ db, companyId: "company-1", locations: [], authorization: { hasAllLocationAccess: true } });
  assert.equal(register.assets.length, 1);
  assert.equal(register.assets[0].attachments[0].uploaded_at, "2026-10-06T11:00:00Z");
  assert.equal(register.assets[0].attachments[0].signed_url, "https://example.test/private-invoice");
  const attachments = queries.find(query => query.table === "asset_attachments");
  assert.deepEqual(attachments.filters, [["company_id", "company-1"], ["asset_id", ["asset-1"]]]);
  assert.deepEqual(attachments.orders, ["created_at"]);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", "module", code)(
    (name) => name in mocks ? mocks[name] : require(name), module.exports, module);
  return module.exports;
}
const files = compile("./rental-document.ts");
const pdf = Buffer.from("%PDF-1.4\nTest fixture, not a real rental agreement.\n%%EOF");
test("File validation accepts supported formats and rejects oversized, disguised and empty files", () => {
  for (const [name, type] of [["lease.pdf", "application/pdf"], ["scan.jpg", "image/jpeg"], ["scan.jpeg", "image/jpeg"], ["scan.png", "image/png"]])
    assert.equal(files.validateRentalFile({ name, type, size: 40 }).type, type);
  for (const value of [
    { name: "lease.pdf", type: "application/pdf", size: 0 },
    { name: "lease.pdf", type: "application/pdf", size: 4194305 },
    { name: "lease.svg", type: "image/svg+xml", size: 40 },
    { name: "lease.pdf", type: "text/html", size: 40 },
    { name: "lease.pdf.exe", type: "application/pdf", size: 40 },
  ]) assert.throws(() => files.validateRentalFile(value));
  assert.equal(files.validateRentalFile({ name: "../a\n.pdf", size: 10, type: "" }).name, ".._a_.pdf");
  files.verifyRentalFileBytes(pdf, "application/pdf");
  files.verifyRentalFileBytes(Buffer.from([255, 216, 255]), "image/jpeg");
  files.verifyRentalFileBytes(Buffer.from([137,80,78,71,13,10,26,10]), "image/png");
  assert.throws(() => files.verifyRentalFileBytes(Buffer.from("<script>bad</script>"), "application/pdf"));
});

test("Upload, view, replacement and access checks work through the actual handlers", async () => {
  const company = "11111111-1111-4111-8111-111111111111";
  const rentId = "22222222-2222-4222-8222-222222222222";
  let rent = { id: rentId, allocation_station_code: "CHM", agreement_document_id: null, updated_at: "2026-09-11T06:00:00.000Z" };
  let allowed = true, writable = true, failUpload = false, failAttach = false, committedError = false, uncertain = false;
  const documents = [], stored = new Map(), removed = [], queries = [], signs = [];
  const context = {
    companyId: company, authorization: { userId: company, hasAllLocationAccess: false },
    locations: [{ station_code: "CHM" }], db: {
      from(table) {
        const filters = {};
        const query = {
          select() { return query; }, eq(key, value) { filters[key] = value; queries.push([table,key,value]); return query; },
          is(key, value) { filters[key] = value; return query; },
          in(key, value) { assert.deepEqual(value, ["CHM"]); return query; },
          order() { return query; }, limit() { return query; },
          maybeSingle() { return query; },
          then(resolve) {
            if (table === "finance_rent_master") return Promise.resolve({ data: allowed && filters.id === rentId ? rent : null, error: null }).then(resolve);
            const matches = documents.filter((d) => !filters.id || d.id === filters.id);
            return Promise.resolve({ data: filters.id ? matches[0] || null : matches, error: uncertain && filters.id ? { message: "network" } : null }).then(resolve);
          },
        }; return query;
      },
      storage: { from(bucket) {
        assert.equal(bucket, files.rentalDocumentBucket);
        return {
          async upload(path, bytes, options) { assert.equal(options.upsert, false); if (failUpload) return { error: { message: "failed" } }; stored.set(path, bytes); return { error: null }; },
          async remove(paths) { removed.push(...paths); paths.forEach((path) => stored.delete(path)); return { error: null }; },
          async createSignedUrl(path, expires, options) { signs.push({ path, expires, options }); return { data: { signedUrl: "https://storage.example.test/signed" }, error: null }; },
        };
      } },
      async rpc(name, args) {
        assert.equal(name, "finance_attach_rent_document");
        assert.equal(args.p_company, company); assert.equal(args.p_actor, company);
        assert.equal(args.p_rent, rentId); assert.equal(args.p_allocation, "CHM");
        if (failAttach || uncertain) return { error: { message: "Rent changed" } };
        const d = { ...args.p_document, rent_id: rentId, company_id: company, uploaded_at: new Date().toISOString() };
        assert.match(d.sha256, /^[a-f0-9]{64}$/);
        documents.push(d); rent = { ...rent, agreement_document_id: d.id, updated_at: new Date(Date.parse(rent.updated_at) + 1000).toISOString() };
        return { error: committedError ? { message: "connection interrupted" } : null, data: d.id };
      },
    },
  };
  const server = compile("./rental-document-server.ts", { "server-only": {}, "./rental-document": files });
  const mocks = {
    "next/cache": { revalidatePath(path) { assert.equal(path, "/master/rent"); } },
    "@/lib/finance/data": { financeContext: async (code) => { assert.equal(code, "finance_rent"); return context; }, canWriteRent: () => writable },
    "@/lib/finance/rental-document": files,
    "@/lib/finance/rental-document-server": server,
  };
  const routes = compile("../../app/api/finance/rent/[id]/documents/route.ts", mocks);
  const view = compile("../../app/api/finance/rent/[id]/documents/[documentId]/route.ts", mocks);
  const params = { params: { id: rentId } };
  function request({ origin = "https://fin.dropxlogistics.com", expected = rent.updated_at, bytes = pdf } = {}) {
    const form = new FormData(); form.set("file", new File([bytes], "lease.pdf", { type: "application/pdf" })); form.set("expected_updated_at", expected);
    return new Request("https://fin.dropxlogistics.com/api/finance/rent/x/documents", { method: "POST", body: form, headers: { origin, host: "fin.dropxlogistics.com" } });
  }
  writable = false; assert.equal((await routes.POST(request(), params)).status, 403); writable = true;
  assert.equal((await routes.POST(request({ origin: "https://evil.test" }), params)).status, 403);
  assert.equal((await routes.POST(request({ origin: "not-a-url" }), params)).status, 403);
  allowed = false; assert.equal((await routes.POST(request(), params)).status, 404); allowed = true;
  assert.equal((await routes.POST(request({ bytes: Buffer.from("html") }), params)).status, 400);
  assert.equal((await routes.POST(request({ expected: "2026-01-01" }), params)).status, 409);
  assert.equal(stored.size, 0);
  failUpload = true; assert.equal((await routes.POST(request(), params)).status, 502); failUpload = false;
  assert.equal((await routes.POST(request(), params)).status, 201);
  const first = rent.agreement_document_id;
  assert.equal((await routes.POST(request(), params)).status, 201);
  assert.notEqual(first, rent.agreement_document_id); assert.equal(documents.length, 2); assert.equal(stored.size, 2);
  const listing = await routes.GET(new Request("https://fin.dropxlogistics.com"), params);
  assert.equal(listing.headers.get("cache-control"), "private, no-store");
  assert.equal((await listing.json()).documents.length, 2);
  const fileParams = { params: { id: rentId, documentId: first } };
  assert.equal((await view.GET(new Request("https://fin.dropxlogistics.com/file"), fileParams)).status, 302);
  assert.equal(signs[0].expires, 120); assert.equal(signs[0].options, undefined);
  assert.equal((await view.GET(new Request("https://fin.dropxlogistics.com/file?download=1"), fileParams)).status, 302);
  assert.equal(signs[1].options.download, "lease.pdf");
  allowed = false; assert.equal((await view.GET(new Request("https://fin.dropxlogistics.com/file"), fileParams)).status, 404); allowed = true;
  assert.equal(signs.length, 2);
  const saved = rent.agreement_document_id;
  failAttach = true; assert.equal((await routes.POST(request(), params)).status, 409); failAttach = false;
  assert.equal(removed.length, 1); assert.equal(stored.size, 2); assert.equal(saved, rent.agreement_document_id);
  committedError = true; assert.equal((await routes.POST(request(), params)).status, 201); committedError = false;
  assert.equal(removed.length, 1); assert.equal(stored.size, 3);
  uncertain = true; assert.equal((await routes.POST(request(), params)).status, 503); uncertain = false;
  assert.equal(removed.length, 1); // Uncertain commits must never delete a possibly linked file.
  assert.ok(queries.filter((q) => q[1] === "company_id").every((q) => q[2] === company));
});

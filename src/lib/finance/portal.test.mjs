import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  new Function("require", "exports", "module", code)((name) => name in mocks ? mocks[name] : require(name), module.exports, module);
  return module.exports;
}
const surface = compile("./surface.ts");
const auth = { companyId: "company-1", hasAllLocationAccess: true, locationScopeIds: [], permissions: {}, isMasterOwner: true };
const hasPermission = (user, code) => user.isMasterOwner || Boolean(user.permissions[code]?.canView || user.permissions[code]?.canAdd || user.permissions[code]?.canEdit);
const navigation = compile("./navigation.ts", { "@/lib/authorization": { hasPermission }, "@/lib/finance/surface": surface });

test("Finance domains and previews select Finance without claiming other products", () => {
  for (const host of ["fin.dropxlogistics.com", "finance.dropxlogistics.com", "dropx-finance.vercel.app", "dropx-finance-abc-dropx1.vercel.app"]) assert.equal(surface.isFinanceHostName(host), true, host);
  for (const host of ["dashboard.dropxlogistics.com", "admin-panel.dropxlogistics.com", "ops.dropxlogistics.com", "people.dropxlogistics.com", "recruit.dropxlogistics.com"]) assert.equal(surface.isFinanceHostName(host), false, host);
});
test("Finance allows payment and master pages but rejects unrelated surfaces", () => {
  for (const path of ["/", "/finance", "/payments/approvals", "/master/payment-heads", "/users"]) assert.equal(surface.isFinancePortalPath(path), true, path);
  for (const path of ["/dashboard", "/fleet", "/people/all", "/master/locations", "/platform-admin", "/finance-fake"]) assert.equal(surface.isFinancePortalPath(path), false, path);
});
test("Finance login return paths remain within Finance", () => {
  assert.equal(surface.safeFinanceNextPath("/payments/report?month=2026-08"), "/payments/report?month=2026-08");
  for (const path of ["//example.com", "https://example.com", "/fleet", "/finance/../people", "/login", null]) assert.equal(surface.safeFinanceNextPath(path), "/");
});
test("Owners and restricted finance roles land on their first permitted page", () => {
  assert.equal(navigation.firstAllowedFinanceHref(auth), "/finance");
  const restricted = { ...auth, isMasterOwner: false, permissions: { payment_approvals: { canView: true } } };
  assert.equal(navigation.hasFinancePortalAccess(restricted), true);
  assert.equal(navigation.firstAllowedFinanceHref(restricted), "/payments/approvals");
  assert.equal(navigation.hasFinancePortalAccess({ ...restricted, permissions: {} }), false);
});

const redirect = (path) => { throw new Error(`redirect:${path}`); };
const passthrough = ({ children }) => children;
const rootMocks = {
  "@/components/app-shell": { AppShell: passthrough },
  "@/components/page-head": { PageHead: () => null },
  "@/lib/app-navigation": { firstAllowedHref: () => "/" },
  "@/lib/authorization": { getAuthorization: async () => auth, hasPermission },
  "@/lib/people/navigation": { hasPeoplePortalAccess: () => true, firstAllowedPeopleHref: () => "/people/all" },
  "@/lib/people/surface": { isPeopleHostName: host => host === "people.dropxlogistics.com" },
  "@/lib/finance/navigation": navigation,
  "@/lib/finance/surface": surface,
  "next/navigation": { redirect }
};
test("Finance root redirects to Finance; main Dashboard keeps its existing renderer", async () => {
  let host = "fin.dropxlogistics.com";
  const page = compile("../../app/page.tsx", { ...rootMocks, "next/headers": { headers: () => new Headers({ host }) } }).default;
  await assert.rejects(page(), /redirect:\/finance$/);
  host = "dashboard.dropxlogistics.com";
  const main = renderToStaticMarkup(await page());
  assert.match(main, /Operating process/);
  assert.match(main, /MTD payable/);
});

test("Finance sign-in keeps authenticated and new sessions on the Finance surface", async () => {
  let user = auth;
  let signedIn = true;
  const page = compile("../../app/login/page.tsx", {
    ...rootMocks,
    "next/headers": { headers: () => new Headers({ host: "fin.dropxlogistics.com" }) },
    "@/components/document-title": { DocumentTitle: () => null },
    "@/components/ops-login-panel": { OpsLoginPanel: () => null },
    "@/components/people-login-panel": { PeopleLoginPanel: () => null },
    "@/components/submit-button": { SubmitButton: passthrough },
    "@/lib/authorization": { getAuthorization: async () => user, hasPermission },
    "@/lib/access-surface": { opsAccessPageCodes: [] },
    "@/lib/ops-pulse/auth": {},
    "@/lib/ops-pulse/navigation": {},
    "@/lib/people/auth": {},
    "@/lib/supabase-server": { createServerSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: signedIn ? { id: "user" } : null } }) } }) },
    "./actions": { signInWithGoogle: "/test-signin" }
  }).default;
  await assert.rejects(page({}), /redirect:\/finance$/);
  await assert.rejects(page({ searchParams: { next: "/dashboard" } }), /redirect:\/finance$/);
  user = { ...auth, isMasterOwner: false, permissions: { payment_approvals: { canView: true } } };
  await assert.rejects(page({}), /redirect:\/payments\/approvals$/);
  user = { ...user, permissions: {} };
  await assert.rejects(page({}), /redirect:\/unauthorized\?page=finance_portal/);
  signedIn = false;
  const html = renderToStaticMarkup(await page({ searchParams: { next: "//example.com" } }));
  assert.match(html, /Sign in to DropX Finance/);
  assert.match(html, /name="next"[^>]*value="\/"/);
});

function financePage(pages, user = auth, error = null) {
  const calls = [];
  let page = 0;
  const query = new Proxy({}, { get(_target, method) {
    if (method === "then") return resolve => resolve({ data: pages[page++] ?? [], error });
    return (...args) => { calls.push([method, ...args]); return query; };
  } });
  return { calls, render: compile("../../app/finance/page.tsx", {
    "next/link": { default: ({ children, href }) => require("react").createElement("a", { href }, children) },
    "@/components/app-shell": { AppShell: passthrough },
    "@/components/page-head": { PageHead: ({ title }) => require("react").createElement("h1", null, title) },
    "@/lib/authorization": { requirePagePermission: async () => user, hasPermission },
    "@/lib/company-scope": { requireCompanyId: () => user.companyId },
    "@/lib/supabase-admin": { supabaseAdmin: { from: name => { calls.push(["from",name]); return query; } } },
    "./finance.css": {}
  }).default };
}
test("Finance metrics page through live records and enforce the company filter", async () => {
  const fixture = { status: "PENDING", amount: 100 };
  const page = financePage([Array(1000).fill(fixture), [fixture]]);
  const html = renderToStaticMarkup(await page.render());
  assert.match(html, /1001/);
  assert.deepEqual(page.calls.filter(c => c[0] === "range"), [["range",0,999],["range",1000,1999]]);
  assert.equal(page.calls.filter(c => c[0] === "eq" && c[1] === "company_id" && c[2] === "company-1").length, 2);
});
test("Location-scoped users cannot read company-wide Finance totals", async () => {
  const page = financePage([[]], { ...auth, hasAllLocationAccess: false, locationScopeIds: ["station-1"] });
  await page.render();
  assert.deepEqual(page.calls.find(c => c[0] === "in"), ["in","location_id",["station-1"]]);
});
test("Data errors show an error instead of false zero metrics", async () => {
  const page = financePage([[]], auth, { message: "Connection unavailable" });
  const html = renderToStaticMarkup(await page.render());
  assert.match(html, /Unable to load Finance data/);
  assert.doesNotMatch(html, /Processed this month/);
});

test("The dedicated Finance release does not run other products' scheduled jobs", () => {
  const config = JSON.parse(readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.crons, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { activeOpsHref, searchOpsNavigation } from "./design-navigation.ts";

const nav = [
  { code: "home", label: "Command Center", href: "/", icon: "#" },
  { code: "operations", label: "Operations", icon: "O", children: [
    { label: "COD Status", href: "/cod/status" },
    { label: "Store Audits", href: "/store-audits" },
  ] },
  { code: "fleet", label: "Fleet", icon: "F", children: [
    { label: "Vehicles", href: "/fleet?tab=vehicles" },
    { label: "Tracking", href: "/fleet?tab=tracking" },
  ] },
];
test("menu search retains only authorized items and never mutates their routes", () => {
  const before = JSON.stringify(nav);
  assert.deepEqual(searchOpsNavigation(nav, "operations COD")[0].children, [nav[1].children[0]]);
  assert.deepEqual(searchOpsNavigation(nav, "fleet"), [nav[2]]);
  assert.deepEqual(searchOpsNavigation(nav, "user access"), []);
  assert.deepEqual(searchOpsNavigation(nav, "   "), nav);
  assert.equal(JSON.stringify(nav), before);
});
test("active page follows nested routes and query tabs without losing filters", () => {
  assert.equal(activeOpsHref(nav, "/store-audits", "audit=sample", "Operations"), "/store-audits");
  assert.equal(activeOpsHref(nav, "/store-audits/detail", "", ""), "/store-audits");
  assert.equal(activeOpsHref(nav, "/fleet", "tab=tracking&station=sample", "Fleet"), "/fleet?tab=tracking");
  assert.equal(activeOpsHref(nav, "/fleet", "", "Fleet"), "/fleet?tab=vehicles");
  assert.equal(activeOpsHref(nav, "/", "from=2026-10-01", ""), "/");
  assert.equal(activeOpsHref(nav, "/unavailable", "", ""), undefined);
});


test('attendance query selects Shift Attendance on both public and internal command-center routes',()=>{
  const items=[...nav,{code:'ops_rostering',label:'Shift Attendance',href:'/ops-pulse?view=manpower',icon:'S'},{code:'ops_rostering',label:'Rostering',href:'/rostering',icon:'S'}];
  for(const path of ['/','/ops-pulse']){
    assert.equal(activeOpsHref(items,path,'view=manpower&location=store&date=2026-10-20','Shift Attendance'),'/ops-pulse?view=manpower');
    assert.equal(activeOpsHref(items,path,'','Command Center'),'/');
  }
  assert.equal(activeOpsHref(items,'/rostering','','Rostering'),'/rostering');
});

// Exercise the real PendingLink too: route ranking alone missed its independent
// pathname-only current state, which also highlighted and disabled Command Center.
function renderNavigation(pathname, search, active) {
  const require = createRequire(import.meta.url);
  const mocks = {
    "next/navigation": { usePathname: () => pathname, useSearchParams: () => new URLSearchParams(search), useRouter: () => ({}) },
    "next/link": ({ prefetch, scroll, ...props }) => createElement("a", props),
    "@/components/payment-notification-provider": { PaymentNavBadge: () => null },
    "@/lib/ops-pulse/design-navigation": { activeOpsHref, searchOpsNavigation },
  };
  function load(file) {
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    new Function("require", "module", "exports", code)(name => mocks[name] ?? require(name), module, module.exports);
    return module.exports;
  }
  mocks["@/components/pending-link"] = load("../../components/pending-link.tsx");
  const { OpsDesignNavigation } = load("../../components/ops-design-navigation.tsx");
  const items = [...nav, { code: "ops_rostering", label: "Shift Attendance", href: "/ops-pulse?view=manpower", icon: "S" }];
  return renderToStaticMarkup(createElement(OpsDesignNavigation, { items, active }));
}

test("rendered attendance navigation has one selected item and leaves Command Center clickable", () => {
  for (const pathname of ["/", "/ops-pulse"]) {
    const html = renderNavigation(pathname, "view=manpower&location=station&date=2026-10-20", "Shift Attendance");
    const links = html.match(/<a\b[^>]*>.*?<\/a>/gs);
    const selected = links.filter(link => link.includes('aria-current="page"'));
    assert.equal(selected.length, 1, `${pathname} should expose only one current page`);
    assert.match(selected[0], /Shift Attendance/);
    const command = links.find(link => link.includes('href="/"'));
    assert.doesNotMatch(command, /aria-disabled="true"|aria-current="page"|\b(?:is-current|disabled-current)\b/);
  }
});

test("rendered command-center navigation retains its single selected item with date filters", () => {
  const html = renderNavigation("/", "from=2026-10-01&to=2026-10-20", "Command Center");
  const selected = (html.match(/<a\b[^>]*>.*?<\/a>/gs)).filter(link => link.includes('aria-current="page"'));
  assert.equal(selected.length, 1);
  assert.match(selected[0], /Command Center/);
});

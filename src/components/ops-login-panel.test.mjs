import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const React = require("react");
let pending = false;
function compile(file, mocks = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "exports", "module", code)(name => name in mocks ? mocks[name] : require(name), module.exports, module);
  return module.exports;
}
const brand = compile("./ops-pulse-brand.tsx");
const { OpsLoginPanel } = compile("./ops-login-panel.tsx", {
  react: { ...React, useEffect: () => {}, useState: value => [value, () => {}] },
  "react-dom": { useFormStatus: () => ({ pending }) },
  "next/image": { default: ({ priority, unoptimized, ...props }) => React.createElement("img", props) },
  "@/components/ops-pulse-brand": brand,
  "@/app/login/actions": { signInWithGoogle: "/existing-google-action" },
  "./ops-login-panel.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) }
});
const render = (props = {}) => renderToStaticMarkup(React.createElement(OpsLoginPanel, props));

test("Both existing brand assets and the OpsPulse identity remain present", () => {
  const html = render();
  assert.match(html, /src="\/dropx-logo.png"/);
  assert.match(html, /src="\/opspulse\/mark.svg\?v=2"/);
  assert.match(html, /role="img" aria-label="OpsPulse/);
});
test("Google sign-in preserves the server action and return-path field", () => {
  const html = render({ nextPath: "/ops-pulse/review?station=test" });
  assert.match(html, /action="\/existing-google-action"/);
  assert.match(html, /name="next"[^>]*value="\/ops-pulse\/review\?station=test"/);
  assert.match(html, /Continue with Google/);
});
test("Pending sign-in disables repeat submission and gives clear feedback", () => {
  pending = true;
  try {
    const html = render();
    assert.match(html, /disabled="" aria-busy="true"/);
    assert.match(html, /Opening Google/);
  } finally { pending = false; }
});
test("Server messages are accessible and HTML-escaped", () => {
  const html = render({ initialMessage: "<script>bad</script>" });
  assert.match(html, /role="alert"/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
});
test("Android download stays unchanged and iOS guidance is expandable", () => {
  const html = render();
  assert.match(html, /href="\/downloads\/DropX-OpsPulse.apk" download=""/);
  assert.match(html, /<details/);
  assert.match(html, /<summary>Using an iPhone or iPad\?/);
  assert.doesNotMatch(html, /Install web app/);
});
test("The operations schematic is descriptive, not fabricated live data", () => {
  const html = render();
  for (const area of ["Performance", "Capacity", "Cash", "Fleet"]) assert.ok(html.includes(area));
  assert.match(html, /role="group" aria-label="OpsPulse brings four operational areas/);
  assert.doesNotMatch(html, /\d+%|₹|live data|uptime/i);
});

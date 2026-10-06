import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL("./shift-punch-times.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
new Function("require", "module", "exports", code)(require, module, module.exports);
const render = props => renderToStaticMarkup(createElement(module.exports.ShiftPunchTimes, props));

test("shows separate labelled IN and OUT without any roster dependency", () => {
  const html = render({ inTime: "2026-10-05T06:57:51Z", outTime: "2026-10-05T16:23:25Z" });
  assert.match(html, />IN 12:27 pm<\/b>/);
  assert.match(html, />OUT 09:53 pm<\/b>/);
});
test("a single punch never fabricates an OUT time", () => {
  const html = render({ inTime: "2026-10-05T02:11:45Z", outTime: null });
  assert.match(html, /IN 07:41 am/);
  assert.match(html, /OUT pending/);
});
test("preserves OUT-only evidence and does not invent IN", () => {
  const html = render({ inTime: null, outTime: "2026-10-05T16:23:25Z" });
  assert.match(html, /IN —/);
  assert.match(html, /OUT 09:53 pm/);
});
test("no punches stays empty", () => assert.equal(render({ inTime: null, outTime: null }), "<b>—</b>"));

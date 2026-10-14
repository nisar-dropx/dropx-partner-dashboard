// Local-only, synthetic-data visual check of the real Review Desk component.
// No authentication, database access, financial writes or production data.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
const require = createRequire(import.meta.url);
export function previewMarkup() {
  const source = readFileSync(new URL("../src/components/performance-review-desk.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ["money", "AssociateDeliveryBreakdown"].includes(node.name?.text)).map(node => node.getText(ast));
  const module = { exports: {} };
  new Function("require", "module", "exports", "ReviewDetailsClose", ts.transpileModule(`${functions.join("\n")}\nexport { AssociateDeliveryBreakdown };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }
  }).outputText)(require, module, module.exports, () => React.createElement("button", { className: "btn secondary" }, "Close"));
  const base = { providerIds: [], delivered: 50, assigned: 60, paymentSetupStatus: "Mapped", costStatus: null,
    cpsShipments: 50, totalPay: 1000, associateCps: 20, stationCpsImpact: 1.25 };
  const rows = [
    { ...base, associateId: "EXAMPLE-1", name: "Daily-pay associate", paymentScheme: "Fixed per day", rates: [{ label: "Fixed pay", rate: 1000, basis: "per day" }] },
    { ...base, associateId: "EXAMPLE-2", name: "Monthly-pay associate", paymentScheme: "Fixed per month", totalPay: 800, associateCps: 16, stationCpsImpact: 1, rates: [{ label: "Monthly pay", rate: 24000, basis: "per month · attendance based" }] },
    { ...base, associateId: "EXAMPLE-3", name: "MG associate", paymentScheme: "MG per day", totalPay: 769, associateCps: 15.38, stationCpsImpact: 0.96125, rates: [{ label: "Minimum guarantee", rate: 769, basis: "per day" }] },
    { ...base, associateId: "EXAMPLE-4", name: "Per-package associate", paymentScheme: "Per packet", totalPay: 750, associateCps: 15, stationCpsImpact: 0.9375, rates: [{ label: "Delivery", rate: 15, basis: "per delivery" }] },
    { ...base, associateId: "EXAMPLE-5", name: "Missing input example", paymentScheme: "MG per day", totalPay: 0, associateCps: null, stationCpsImpact: null, costStatus: "Cost pending: attendance needs review", rates: [{ label: "MG", rate: 769, basis: "per day" }] },
  ];
  const view = renderToStaticMarkup(React.createElement(module.exports.AssociateDeliveryBreakdown, { rows, total: 250 }));
  const styles = ["../src/app/globals.css", "../src/app/ops-pulse/performance/review-desk.css"].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review Desk payment split — local test</title><style>${styles}\nbody{margin:0;padding:20px;background:#f5f7fb;font-family:Arial,sans-serif}main{max-width:1550px;margin:auto;background:white;padding:16px;border-radius:12px}h1{font-size:22px}header p{color:#64748b;font-size:13px}.performance-associate-popover{display:block!important;position:static!important;width:100%!important;}</style></head><body><main class="performance-review-desk"><header><h1>Associate payment mapping &amp; CPS</h1><p>Local preview · synthetic examples only · not published</p></header><section class="performance-review-facts"><details class="performance-fact-card" open><summary>Delivered · payment and cost split</summary>${view}</details></section></main></body></html>`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer((request, response) => { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(previewMarkup()); })
    .listen(4318, "127.0.0.1", () => console.log("Local synthetic preview: http://127.0.0.1:4318"));
}

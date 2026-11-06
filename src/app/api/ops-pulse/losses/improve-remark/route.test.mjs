import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { responseActions } from "../../../../../lib/ops-pulse/loss-response-actions.ts";

const source = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(state, output) {
  const calls = [];
  const query = { select: () => query, eq: () => query,
    maybeSingle: async () => ({ data: { enabled: true, workflow_status: state } }) };
  const mocks = {
    "@/lib/ops-pulse/assistant-speech": { generateOpsText: async (_, draft) => { calls.push(draft); return output; } },
    "@/lib/ops-pulse/nl-recovery-context": { recoveryContext: async () => ({ scope: { company: "company" }, caseKey: "case" }) },
    "@/lib/ops-pulse/loss-response-actions": { responseActions },
    "@/lib/supabase-admin": { supabaseAdmin: { from: () => query } },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", source)(key => mocks[key], mod, mod.exports);
  return { calls, post: () => mod.exports.POST(new Request("https://example.org/improve", {
    method: "POST", body: JSON.stringify({ month: "2026-09", case_key: "case", note: "2 box received" }),
  })) };
}

test("station can preview a returned remark, sending only its text to the model", async () => {
  const h = harness("returned", "We received 2 boxes.");
  assert.deepEqual(await (await h.post()).json(), { suggestion: "We received 2 boxes." });
  assert.deepEqual(h.calls, ["2 box received"]);
});
test("reviewed cases cannot call the model", async () => {
  const h = harness("awaiting_review", "");
  assert.equal((await h.post()).status, 403);
  assert.deepEqual(h.calls, []);
});
test("a rewritten quantity cannot be presented to the station", async () => {
  assert.equal((await harness("awaiting_station", "We received 3 boxes.").post()).status, 422);
});

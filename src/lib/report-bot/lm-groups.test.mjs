import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { discoveryLocations } from "./lm-group-scope.ts";
import { canSendToGroup } from "./logic.ts";

test("discovery respects station boundaries and workspace ownership", () => {
  const locations = [
    { id: "1", station_code: "TLPA" },
    { id: "2", station_code: "KTUB" },
  ];
  assert.deepEqual(
    discoveryLocations("TLPA War Room", undefined, locations, false),
    [locations[0]],
  );
  assert.deepEqual(
    discoveryLocations("TLPA2 War Room", undefined, locations, false),
    [],
  );
  assert.deepEqual(
    discoveryLocations(
      "TLPA",
      { workspace: "dark_store", location_id: "1" },
      locations,
      true,
    ),
    [],
  );
  assert.deepEqual(
    discoveryLocations(
      "TLPA",
      { workspace: "last_mile", location_id: "3" },
      locations,
      false,
    ),
    [],
  );
  assert.deepEqual(
    discoveryLocations("Central", undefined, locations, true),
    locations,
  );
});

test("manual messages require group edit access and live sending; retries use one reference", async () => {
  const require = createRequire(import.meta.url);
  const id = "2bcedf32-b38d-4301-a952-f7600a5d496b";
  let authorized = true,
    visible = true,
    mode = "review";
  const sends = [];
  const filters = new Map();
  const db = {
    from() {
      return this;
    },
    select() {
      return this;
    },
    eq(k, v) {
      filters.set(k, v);
      return this;
    },
    maybeSingle() {
      return {
        data: {
          id,
          workspace: "last_mile",
          location_id: "station",
          wa_group_id: "1@g.us",
          mode,
        },
      };
    },
  };
  const mocks = {
    "@/lib/report-bot/access": {
      canSeeGroup: () => visible,
      reportBotApiAuthorization: (action, workspace) => {
        assert.equal(action, "edit");
        assert.equal(workspace, "last_mile");
        return authorized ? { companyId: "company", userId: "user" } : null;
      },
    },
    "@/lib/report-bot/settings": {
      reportBotDb: () => db,
      loadReportBotSettings: () => ({ mode: "live" }),
    },
    "@/lib/report-bot/logic": { canSendToGroup },
    "@/lib/report-bot/worker-client": {
      WorkerError: Error,
      workerRequest: (settings, path, { body }) => {
        assert.equal(path, "/send");
        sends.push(body);
        return { id: "receipt" };
      },
    },
    "next/server": { NextResponse: Response },
  };
  const module = { exports: {} };
  const source = readFileSync(
    new URL("../../app/api/report-bot/chats/route.ts", import.meta.url),
    "utf8",
  );
  new Function(
    "require",
    "module",
    "exports",
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )((key) => mocks[key] ?? require(key), module, module.exports);
  const post = (origin = "https://ops.example") =>
    module.exports.POST(
      new Request("https://ops.example/api/report-bot/chats", {
        method: "POST",
        headers: { origin },
        body: JSON.stringify({ group: id, reference: id, text: "Status?" }),
      }),
    );
  assert.equal((await post("https://wrong.example")).status, 403);
  authorized = false;
  assert.equal((await post()).status, 403);
  authorized = true;
  visible = false;
  assert.equal((await post()).status, 404);
  visible = true;
  mode = "observe";
  assert.equal((await post()).status, 409);
  assert.equal(sends.length, 0);
  mode = "review";
  assert.deepEqual(await (await post()).json(), { id: "receipt" });
  await post();
  assert.equal(sends[0].client_ref, sends[1].client_ref);
  assert.equal(sends[0].to, "1@g.us");
  assert.deepEqual(Object.fromEntries(filters), {
    id,
    company_id: "company",
    workspace: "last_mile",
    is_enabled: true,
  });
});

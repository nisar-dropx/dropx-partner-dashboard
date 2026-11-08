import test from "node:test";
import assert from "node:assert/strict";
import { filterDispatchSourceRows } from "./lm-source-scope.ts";

const row = (code, extra={}) => ({ id:code, is_ho:false, hide_from_location_list:false, location_models:{code}, ...extra });

test("configured model scope excludes unrelated programmes", () => {
  const rows = filterDispatchSourceRows([row("EDSP"),row("XPT"),row("MDH"),row("ODH")],["EDSP","XPT","AMXL"]);
  assert.deepEqual(rows.map(item=>item.id),["EDSP","XPT"]);
});

test("hidden, head-office and Amazon Now sources remain unavailable", () => {
  const rows = filterDispatchSourceRows([row("EDSP"),row("NOW"),row("EDSP",{is_ho:true}),row("XPT",{hide_from_location_list:true})]);
  assert.deepEqual(rows.map(item=>item.id),["EDSP"]);
});

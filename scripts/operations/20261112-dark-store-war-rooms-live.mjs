/**
 * Link Dark Store war-room WhatsApp groups to their stations and set mode=live.
 *
 * Dry-run by default. APPLY=1 writes.
 *
 *   node scripts/operations/20261112-dark-store-war-rooms-live.mjs
 *   APPLY=1 node scripts/operations/20261112-dark-store-war-rooms-live.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const out = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    try {
      for (const line of readFileSync(resolve(process.cwd(), file), "utf8").split(/\r?\n/)) {
        const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (out[match[1]] == null || out[match[1]] === "") out[match[1]] = value;
      }
    } catch {
      /* optional */
    }
  }
  return out;
}

const env = loadEnv();
const url =
  env.NEXT_PUBLIC_SUPABASE_URL ||
  env.SUPABASE_URL ||
  env.COMPANY_SUPABASE_URL ||
  "https://uimajyffojydenqsegjv.supabase.co";
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / COMPANY_SUPABASE_SERVICE_ROLE_KEY");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const APPLY = process.env.APPLY === "1";
const now = new Date().toISOString();

/** Authoritative WhatsApp JIDs from the connected report-bot /groups list. */
const WAR_ROOMS = [
  { code: "TCC3", jid: "120363424408130632@g.us", nameHint: /TCC3.*War\s*Room/i },
  { code: "TCD4", jid: "120363407865525845@g.us", nameHint: /TCD4.*War\s*room/i },
  { code: "TTB3", jid: "120363424079156767@g.us", nameHint: /TTB3.*War\s*room/i },
  { code: "TTA5", jid: "120363425009535873@g.us", nameHint: /TTA5.*War\s*room/i },
  { code: "TZC4", jid: "120363411844052790@g.us", nameHint: /TZC4.*War\s*room/i },
  { code: "TTG9", jid: "120363427914569852@g.us", nameHint: /TTG9.*War\s*room/i },
  { code: "TFB7", jid: "120363432925308998@g.us", nameHint: /TFB7.*War\s*room/i }
];

const codes = WAR_ROOMS.map((r) => r.code);

const { data: settings, error: settingsError } = await db
  .from("report_bot_settings")
  .select("company_id,mode,worker_url,connection_state,connected_number")
  .eq("company_id", COMPANY)
  .maybeSingle();
if (settingsError) throw new Error(settingsError.message);
console.log("company_bot_settings", settings);

const { data: groups, error: groupsError } = await db
  .from("report_bot_groups")
  .select("id,wa_group_id,group_name,mode,is_enabled,bot_in_group,location_id,workspace,participant_count")
  .eq("company_id", COMPANY)
  .eq("workspace", "dark_store");
if (groupsError) throw new Error(groupsError.message);

const { data: stations, error: stationsError } = await db
  .from("stations")
  .select("id,station_code,station_name,is_active,hide_from_location_list")
  .eq("company_id", COMPANY)
  .in("station_code", codes);
if (stationsError) throw new Error(stationsError.message);

const stationByCode = new Map(
  (stations || []).map((s) => [String(s.station_code).toUpperCase(), s])
);
console.log(
  "stations",
  Object.fromEntries(
    [...stationByCode.entries()].map(([code, s]) => [
      code,
      { id: s.id, name: s.station_name, active: s.is_active }
    ])
  )
);

const plan = [];
for (const room of WAR_ROOMS) {
  const station = stationByCode.get(room.code);
  if (!station) {
    plan.push({ code: room.code, error: "station_missing" });
    continue;
  }
  let group =
    (groups || []).find((g) => g.wa_group_id === room.jid) ||
    (groups || []).find((g) => room.nameHint.test(String(g.group_name || "")));
  plan.push({
    code: room.code,
    jid: room.jid,
    station_id: station.id,
    station_name: station.station_name,
    group_id: group?.id || null,
    group_name: group?.group_name || null,
    before: group
      ? {
          mode: group.mode,
          is_enabled: group.is_enabled,
          bot_in_group: group.bot_in_group,
          location_id: group.location_id
        }
      : null,
    action: group
      ? {
          mode: "live",
          is_enabled: true,
          location_id: station.id,
          wa_group_id: room.jid,
          group_name: group.group_name || `${room.code}: War room`
        }
      : {
          insert: true,
          mode: "live",
          is_enabled: true,
          location_id: station.id,
          wa_group_id: room.jid,
          group_name: `${room.code}: War room`,
          workspace: "dark_store",
          bot_in_group: true,
          participant_count: null
        }
  });
}

console.log(JSON.stringify({ apply: APPLY, plan }, null, 2));

if (!APPLY) {
  console.log("Dry-run only. Re-run with APPLY=1 to write.");
  process.exit(0);
}

if (!settings) {
  throw new Error("report_bot_settings row missing for company");
}
if (settings.mode !== "live") {
  const { error } = await db
    .from("report_bot_settings")
    .update({ mode: "live", updated_at: now })
    .eq("company_id", COMPANY);
  if (error) throw new Error(`Set company bot live: ${error.message}`);
  console.log("company bot mode -> live");
}

for (const item of plan) {
  if (item.error) {
    console.error(`SKIP ${item.code}: ${item.error}`);
    continue;
  }
  if (item.action.insert) {
    const row = {
      company_id: COMPANY,
      workspace: "dark_store",
      wa_group_id: item.action.wa_group_id,
      group_name: item.action.group_name,
      location_id: item.action.location_id,
      mode: "live",
      is_enabled: true,
      bot_in_group: true,
      updated_at: now
    };
    const { data, error } = await db.from("report_bot_groups").insert(row).select("id,group_name,mode,location_id").single();
    if (error) throw new Error(`Insert ${item.code}: ${error.message}`);
    console.log("inserted", data);
    continue;
  }
  const { data, error } = await db
    .from("report_bot_groups")
    .update({
      mode: "live",
      is_enabled: true,
      location_id: item.action.location_id,
      wa_group_id: item.action.wa_group_id,
      updated_at: now
    })
    .eq("id", item.group_id)
    .select("id,group_name,mode,is_enabled,location_id,wa_group_id,bot_in_group")
    .single();
  if (error) throw new Error(`Update ${item.code}: ${error.message}`);
  console.log("updated", data);
}

console.log("DONE");

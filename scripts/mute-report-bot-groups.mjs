/**
 * Disable TFB7 War room + Dark Store Testing groups and their schedules.
 * One-shot ops helper — safe to re-run.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return [line.slice(0, i).trim(), value];
    })
);

const url = env.COMPANY_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const key = env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase URL / service role key in .env");
  process.exit(1);
}

const MUTE = /tfb7|dark\s*store\s*testing|^testing$/i;
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: groups, error } = await db
  .from("report_bot_groups")
  .select("id,group_name,is_enabled,workspace")
  .eq("workspace", "dark_store");
if (error) throw error;

const muted = (groups || []).filter((g) => MUTE.test(String(g.group_name || "").trim()));
console.log("matched groups:", muted.map((g) => ({ id: g.id, name: g.group_name, enabled: g.is_enabled })));
const ids = muted.map((g) => g.id);
if (!ids.length) {
  console.log("No matching groups.");
  process.exit(0);
}

const now = new Date().toISOString();
const { data: upd, error: uerr } = await db
  .from("report_bot_groups")
  .update({ is_enabled: false, updated_at: now })
  .in("id", ids)
  .select("id,group_name,is_enabled");
if (uerr) throw uerr;
console.log("disabled groups:", upd);

const { data: sched, error: serr } = await db
  .from("report_bot_schedules")
  .update({ is_active: false, updated_at: now })
  .in("group_id", ids)
  .select("id,group_id,is_active");
if (serr) throw serr;
console.log("deactivated schedules:", (sched || []).length);

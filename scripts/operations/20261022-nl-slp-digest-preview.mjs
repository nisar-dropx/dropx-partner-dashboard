/**
 * Dry-run digest recipient check (no mail sent).
 * Usage: node scripts/operations/20261022-nl-slp-digest-preview.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const out = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    try {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (out[m[1]] == null || out[m[1]] === "") out[m[1]] = v;
      }
    } catch {
      /* optional */
    }
  }
  return out;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co";
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const DOMAIN = "dropxlogistics.com";
const DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const control = await db
  .from("portal_notification_controls")
  .select("state,config,subject_template")
  .eq("company_id", COMPANY)
  .eq("portal", "ops")
  .eq("event_key", "loss_recovery_action_digest")
  .maybeSingle();
if (control.error) throw new Error(control.error.message);

const items = await db.rpc("nl_loss_recovery_action_items", { p_company: COMPANY });
if (items.error) throw new Error(items.error.message);
const rows = items.data ?? [];
const stationCodes = [...new Set(rows.map((r) => r.station_code).filter(Boolean))];

const stations = await db
  .from("stations")
  .select("id,station_code")
  .eq("company_id", COMPANY)
  .in("station_code", stationCodes.length ? stationCodes.slice(0, 80) : ["__none__"]);
if (stations.error) throw new Error(stations.error.message);

const memberships = await db
  .from("company_product_memberships")
  .select("user_id,location_scope_ids,has_all_location_access,role_code_snapshot")
  .eq("company_id", COMPANY)
  .eq("product_code", "operations")
  .eq("is_active", true);
if (memberships.error) throw new Error(memberships.error.message);
const userIds = [...new Set((memberships.data ?? []).map((m) => m.user_id).filter(Boolean))];
const profiles = await db
  .from("profiles")
  .select("id,email,full_name,is_active")
  .in("id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]);
if (profiles.error) throw new Error(profiles.error.message);
const profileById = new Map((profiles.data ?? []).map((p) => [p.id, p]));

const recipients = new Map();
for (const m of memberships.data ?? []) {
  const profile = profileById.get(m.user_id);
  const email = String(profile?.email || "").toLowerCase();
  if (!profile || profile.is_active === false || !email.endsWith("@" + DOMAIN)) continue;
  const role = String(m.role_code_snapshot || "");
  const isSlpLike = /SLP|OWNER|CLUSTER_HEAD|AOM|CM/i.test(role) || m.has_all_location_access;
  if (!isSlpLike) continue;
  const scope = new Set(m.location_scope_ids ?? []);
  let hits = 0;
  for (const s of stations.data ?? []) {
    if (m.has_all_location_access || scope.has(s.id)) hits += 1;
  }
  if (!hits && !m.has_all_location_access) continue;
  const cur = recipients.get(email) ?? { email, name: profile.full_name || email, role, stations: 0 };
  cur.stations = Math.max(cur.stations, hits);
  recipients.set(email, cur);
}

const list = [...recipients.values()].sort((a, b) => a.email.localeCompare(b.email));
console.log(JSON.stringify({
  event: "digest_dry_run_preview",
  report_date: DATE,
  control: {
    state: control.data?.state,
    delivery_ready: control.data?.delivery_ready ?? control.data?.config?.delivery_ready,
    schedule_time: control.data?.config?.schedule_time,
    subject_template: control.data?.subject_template,
  },
  open_actions: rows.length,
  sample_action_labels: [...new Set(rows.slice(0, 12).map((r) => r.action_label))],
  recipient_count: list.length,
  recipients_sample: list.slice(0, 15),
  all_dropx_domain: list.every((r) => r.email.endsWith("@" + DOMAIN)),
  would_enqueue_when_enabled: rows.length > 0 && list.length > 0,
  note: "Control is intentionally disabled for dry-run; this script never sends mail.",
}, null, 2));

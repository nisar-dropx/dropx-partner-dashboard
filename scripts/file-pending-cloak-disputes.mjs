/**
 * One-shot: file every OpsPulse dispute still stuck on status=submitted.
 * Usage: node scripts/file-pending-cloak-disputes.mjs [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

const CLOAK = "https://cloak.tech.amazon.dev";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const PDF = "application/pdf";
const DRY = process.argv.includes("--dry");
const REASONS = new Set([
  "WRTS but MDR",
  "Shipment returned to origin",
  "Delivered/Cash in Bank",
  "Scan Update Issue",
  "Scan Marked by someone not from Station",
  "Pickup Done Issue",
  "Processed as Orphan",
  "BuyBack Recovery",
  "Seller Issue",
  "Physically available at SP",
  "Reject Label Issue",
  "Double label issue",
  "Customer Abuse",
  "Other",
]);

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const root = path.resolve(import.meta.dirname, "..");
const env = {
  ...loadEnv(path.join(root, "../../Workforce-worker/.dev.vars")),
  ...loadEnv(path.join(root, "../../amazon-edd-worker/.dev.vars")),
  ...loadEnv(path.join(root, ".env.local")),
};
const url =
  env.COMPANY_SUPABASE_URL ||
  env.NEXT_PUBLIC_SUPABASE_URL ||
  env.SUPABASE_URL;
const key =
  env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing company Supabase URL/key.");
  process.exit(1);
}

const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function cloakJson(res) {
  const html = (res.headers.get("content-type") ?? "").includes("text/html");
  if (
    res.status === 401 ||
    res.status === 403 ||
    (res.status >= 300 && res.status < 400) ||
    html
  )
    throw new Error("Cloak session expired or unauthorized.");
  if (!res.ok) throw new Error(`Cloak returned ${res.status}.`);
  return res.json();
}

async function cloakGet(cookie, apiPath, params) {
  const res = await fetch(`${CLOAK}${apiPath}?${new URLSearchParams(params)}`, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/json, text/plain, */*",
      cookie,
      referer: `${CLOAK}/`,
      "user-agent": UA,
    },
  });
  return cloakJson(res);
}

async function cloakPost(cookie, apiPath, body) {
  const res = await fetch(`${CLOAK}${apiPath}`, {
    method: "POST",
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      cookie,
      origin: CLOAK,
      referer: `${CLOAK}/`,
      "x-csrf-token": "required",
      "user-agent": UA,
    },
    body: JSON.stringify(body),
  });
  return cloakJson(res);
}

async function buildProof(files) {
  if (!files.length) return null;
  if (files.length === 1 && files[0].contentType === PDF) return files[0].bytes;
  const out = await PDFDocument.create();
  for (const file of files) {
    if (file.contentType === PDF) {
      const source = await PDFDocument.load(file.bytes);
      for (const page of await out.copyPages(source, source.getPageIndices()))
        out.addPage(page);
      continue;
    }
    const jpeg = await sharp(file.bytes)
      .rotate()
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
    const image = await out.embedJpg(jpeg);
    out
      .addPage([image.width, image.height])
      .drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
  }
  return out.save();
}

function remarks(text, cctv) {
  return [String(text || "").trim(), String(cctv || "").trim()]
    .filter(Boolean)
    .join("\n\n");
}

async function fileOne(cookie, tid, reason, partnerRemarks, proof, revision, stage) {
  const [me, list, disputes] = await Promise.all([
    cloakGet(cookie, "/api/v1/auth/me", {}),
    cloakGet(cookie, "/api/v1/getTIDData", { tid, country: "IN" }),
    cloakGet(cookie, "/api/v1/getDisputeDetails", {
      tid,
      dataSource: "live",
      country: "IN",
    }),
  ]);
  const heldRows = (Array.isArray(disputes) ? disputes : []).filter(
    (d) => d?.tid === tid,
  );
  const heldRev = (rev) =>
    heldRows.find((d) => String(d.revision ?? "") === rev) ??
    (rev === "1" ? heldRows[0] : undefined);
  const held1 = heldRev("1");
  const held2 = heldRev("2");
  if (revision === "1" && held1) {
    if (held1.dispute_selected !== "YES")
      throw new Error("Cloak already holds this case as not disputed.");
    return { alreadyFiled: true, proofKey: held1.dispute_proof || "" };
  }
  if (revision === "2" && held2?.dispute_selected === "YES")
    return { alreadyFiled: true, proofKey: held2.dispute_proof || "" };
  const rows = (list.data ?? []).filter((r) => r?.tid === tid);
  const row = rows[0];
  if (rows.length !== 1 || !row)
    throw new Error("Cloak does not list this case in the live month.");
  const liveStage = String(row.current_sla_stage ?? "");
  const stageOk =
    liveStage === stage ||
    (revision === "2" &&
      (stage === "eDSP2" || stage === "NL2") &&
      (liveStage === "eDSP2" || liveStage === "NL2"));
  if (!stageOk)
    throw new Error(
      `Cloak is no longer at ${stage} for this case (now ${liveStage || "unknown"}).`,
    );
  if (revision === "1" && (row.case_status !== "not_started" || held1))
    throw new Error("Cloak is no longer waiting for a first dispute on this case.");
  if (revision === "2" && (!held1 || held1.dispute_selected !== "YES"))
    throw new Error("The first dispute is not recorded in Cloak; response cannot be filed.");
  if (!me.email || !me.permissions?.includes("write:own_data") || !row.value || !row.case_with)
    throw new Error("The Cloak login cannot file disputes right now.");

  let proofKey = "";
  if (proof) {
    const { bucket } = await cloakGet(cookie, "/api/v1/getBucket", {
      name: "partner_proof",
    });
    if (typeof bucket !== "string" || !/^[a-z0-9.-]{3,63}$/.test(bucket))
      throw new Error("Cloak did not name its proof bucket.");
    const slot = await cloakPost(cookie, "/api/v1/presignedUpload", {
      bucketName: bucket,
      fileName: `cloak-${tid}-${revision}.pdf`,
      fileType: PDF,
    });
    const target = slot.url ? new URL(slot.url) : null;
    if (
      !target ||
      target.protocol !== "https:" ||
      target.hostname !== `${bucket}.s3.amazonaws.com` ||
      !slot.key
    )
      throw new Error("Cloak did not return a proof upload link.");
    const put = await fetch(target, {
      method: "PUT",
      headers: { "content-type": PDF },
      body: Buffer.from(proof),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!put?.ok) throw new Error("The proof could not be uploaded to Cloak.");
    proofKey = slot.key;
  }

  const saved = await cloakPost(cookie, "/api/v1/handleDisputeAction", {
    action: "partnerDispute",
    tid,
    dispute_selected: "YES",
    dispute_proof: proofKey,
    dispute_reason: reason,
    partner_remarks: partnerRemarks,
    case_with: row.case_with,
    disputed_by: me.email,
    disputed_time: Date.now(),
    revision,
    value: row.value,
    country: row.country || "IN",
  });
  if (
    saved.updatedItem?.tid !== tid ||
    saved.updatedItem.dispute_selected !== "YES"
  )
    throw new Error("Cloak did not confirm the dispute.");
  return { alreadyFiled: false, proofKey };
}

async function syncCase(company, month, caseKey, details, request, proofKey) {
  const fromStage =
    request.source_stage || details?.extra?.current_sla_stage || null;
  const nextStage =
    fromStage === "eDSP1" ? "NL1" : fromStage === "eDSP2" ? "NL2" : fromStage;
  const extra = { ...(details?.extra ?? {}) };
  extra.dispute_selected = "YES";
  extra.dispute_reason = request.reason;
  extra.partner_remarks = remarks(request.remarks, request.cctv_url);
  extra.revision = request.source_stage === "eDSP2" ? "2" : "1";
  if (proofKey) extra.dispute_proof = proofKey;
  if (nextStage) extra.current_sla_stage = nextStage;
  await db
    .from("nl_loss_month_cases")
    .update({ details: { ...details, case_status: "in_progress", extra } })
    .eq("company_id", company)
    .eq("report", "nl")
    .eq("month", month)
    .eq("case_key", caseKey);
}

const { data: cookieRow, error: cookieErr } = await db
  .from("cloak_sessions")
  .select("cookie")
  .eq("status", "active")
  .eq("account_key", "default")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
if (cookieErr || !cookieRow?.cookie) {
  console.error("No active Cloak session in cloak_sessions.");
  process.exit(1);
}
const cookie = cookieRow.cookie;

const { data: pending, error: pendingErr } = await db
  .from("nl_dispute_requests")
  .select("*")
  .eq("status", "submitted")
  .eq("decision", "dispute")
  .order("submitted_at", { ascending: true })
  .limit(200);
if (pendingErr) {
  console.error(pendingErr);
  process.exit(1);
}

const rows = pending ?? [];
console.log(`Pending dispute submissions: ${rows.length}${DRY ? " (dry run)" : ""}`);

const results = [];
for (const req of rows) {
  const label = `${req.month} ${req.case_key}`;
  try {
    if (!REASONS.has(req.reason) || !String(req.remarks || "").trim())
      throw new Error("Missing Cloak reason/remarks — return to station.");
    const stage = req.source_stage;
    if (!["eDSP1", "eDSP2"].includes(stage))
      throw new Error(`Stage ${stage || "(none)"} cannot be filed from OpsPulse.`);

    const { data: caseRow, error: caseErr } = await db
      .from("nl_loss_month_cases")
      .select("details")
      .eq("company_id", req.company_id)
      .eq("report", "nl")
      .eq("month", req.month)
      .eq("case_key", req.case_key)
      .maybeSingle();
    if (caseErr || !caseRow) throw new Error("Case row missing.");
    const details = caseRow.details ?? {};
    const tid = String(details.tid || "");
    if (!/^[A-Za-z0-9]{6,40}$/.test(tid))
      throw new Error("Case has no usable TID.");

    const ids = (req.attachments || []).map((a) => a.id).filter(Boolean);
    const files = [];
    if (ids.length) {
      const { data: stored, error: attErr } = await db
        .from("nl_recovery_attachments")
        .select("id,storage_bucket,storage_path,content_type")
        .eq("company_id", req.company_id)
        .eq("month", req.month)
        .eq("case_key", req.case_key)
        .in("id", ids);
      if (attErr || (stored ?? []).length !== ids.length)
        throw new Error("Proof files could not be read.");
      for (const id of ids) {
        const row = stored.find((r) => r.id === id);
        const file = await db.storage
          .from(row.storage_bucket)
          .download(row.storage_path);
        if (file.error || !file.data)
          throw new Error("Proof download failed.");
        files.push({
          bytes: new Uint8Array(await file.data.arrayBuffer()),
          contentType: String(row.content_type || file.data.type || "application/pdf"),
        });
      }
    }
    const proof = await buildProof(files);
    if (DRY) {
      results.push({ label, ok: true, dry: true, stage, tid });
      console.log(`DRY ${label} tid=${tid} stage=${stage}`);
      continue;
    }

    const filed = await fileOne(
      cookie,
      tid,
      req.reason,
      remarks(req.remarks, req.cctv_url),
      proof,
      stage === "eDSP2" ? "2" : "1",
      stage,
    );
    const note = filed.alreadyFiled
      ? "Already filed in Cloak — nothing was sent again."
      : `Filed in Cloak from OpsPulse bulk trigger${filed.proofKey ? ` with proof ${filed.proofKey}` : " without a proof file"}.`;
    const { data: saved, error: saveErr } = await db.rpc(
      "save_nl_dispute_request",
      {
        p_company: req.company_id,
        p_month: req.month,
        p_case: req.case_key,
        p_version: req.version,
        p_action: "file",
        p_values: { desk_note: note },
        p_actor: req.updated_by,
        p_name: req.updated_by_name || "Cloak bulk file",
      },
    );
    if (saveErr)
      throw new Error(
        `Cloak filed, but OpsPulse record failed: ${saveErr.message}`,
      );
    await syncCase(
      req.company_id,
      req.month,
      req.case_key,
      details,
      req,
      filed.proofKey,
    ).catch(() => undefined);
    results.push({
      label,
      ok: true,
      alreadyFiled: filed.alreadyFiled,
      tid,
    });
    console.log(
      `OK ${label} tid=${tid}${filed.alreadyFiled ? " (already in Cloak)" : ""}`,
    );
  } catch (e) {
    results.push({ label, ok: false, error: String(e?.message || e) });
    console.log(`FAIL ${label}: ${e?.message || e}`);
  }
}

const ok = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ ok, fail, results }, null, 2));
process.exit(fail ? 2 : 0);

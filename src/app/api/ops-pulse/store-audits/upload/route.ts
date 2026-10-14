import { randomUUID } from "node:crypto";
import { readAudit, db, proofs } from "@/lib/ops-pulse/store-audits/server";
import {
  canInspect,
  canRespond,
  questions,
} from "@/lib/ops-pulse/store-audits/model";
export const dynamic = "force-dynamic";
const bucket = "ops-pulse-documents";
const types = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
export async function POST(request: Request) {
  try {
    const input = await request.json();
    const c = await readAudit(String(input.auditId));
    if (c.auth.readOnly) throw Error("Preview is read-only.");
    const phase = input.kind === "response" ? "response" : "audit";
    const allowed =
      phase === "audit"
        ? canInspect(c.auth, c.master.settings, c.audit)
        : canRespond(c.auth, c.master.settings, c.audit) &&
          c.audit.findings.some(
            (f) => f.questionId === input.questionId && f.state === "open",
          );
    if (!allowed)
      return Response.json(
        { error: "Evidence is not editable for this audit." },
        { status: 403 },
      );
    const q = questions(c.audit.template).find(
      (q) => q.id === input.questionId,
    );
    if (!q) throw Error("Choose a question from this audit.");
    const rule = phase === "audit" ? q.evidence : q.responseEvidence;
    const prefix = `${c.companyId}/store-audits/${c.audit.id}/${phase}/${q.id}/${c.auth.userId}/`;
    if (input.phase === "prepare") {
      const name = String(input.fileName || "")
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .slice(0, 120),
        size = Number(input.size),
        mime = String(input.contentType);
      if (
        !name ||
        !types.has(mime) ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 30 * 1024 * 1024
      )
        throw Error("Use a photo or PDF up to 30 MB.");
      if (
        (await proofs(c, c.audit.id)).filter(
          (p) => p.question_id === q.id && p.phase === phase,
        ).length >= rule.max
      )
        throw Error(`This question permits up to ${rule.max} files.`);
      const id = randomUUID(),
        path = `${prefix}${id}-${name}`;
      const r = await db().from("ops_store_audit_evidence").insert({
        id,
        company_id: c.companyId,
        audit_id: c.audit.id,
        question_id: q.id,
        phase,
        file_name: name,
        size,
        content_type: mime,
        path,
        uploaded_by: c.auth.userId,
      });
      if (r.error) throw Error(r.error.message);
      const signed = await db()
        .storage.from(bucket)
        .createSignedUploadUrl(path);
      if (signed.error) throw Error(signed.error.message);
      return Response.json({ id, bucket, path, token: signed.data.token });
    }
    const row = await db()
      .from("ops_store_audit_evidence")
      .select("*")
      .eq("company_id", c.companyId)
      .eq("audit_id", c.audit.id)
      .eq("id", String(input.id))
      .eq("uploaded_by", c.auth.userId)
      .eq("question_id", q.id)
      .eq("phase", phase)
      .single();
    if (row.error || !row.data.path.startsWith(prefix))
      throw Error("Upload unavailable.");
    if (input.phase === "remove") {
      const removed = await db()
        .from("ops_store_audit_evidence")
        .delete()
        .eq("id", row.data.id)
        .eq("company_id", c.companyId);
      if (removed.error) throw Error(removed.error.message);
      await db().storage.from(bucket).remove([row.data.path]);
      return Response.json({ ok: true });
    }
    if (input.phase !== "complete") throw Error("Unknown upload operation.");
    const folder = row.data.path.slice(0, row.data.path.lastIndexOf("/")),
      name = row.data.path.split("/").pop();
    const listed = await db()
      .storage.from(bucket)
      .list(folder, { search: name });
    const file = listed.data?.find((f) => f.name === name);
    if (
      listed.error ||
      !file ||
      file.metadata?.size !== row.data.size ||
      file.metadata?.mimetype !== row.data.content_type
    )
      throw Error("Uploaded file could not be verified.");
    if (
      !row.data.ready &&
      (await proofs(c, c.audit.id)).filter(
        (p) => p.question_id === q.id && p.phase === phase,
      ).length >= rule.max
    )
      throw Error(`This question permits up to ${rule.max} files.`);
    const saved = await db()
      .from("ops_store_audit_evidence")
      .update({ ready: true })
      .eq("id", row.data.id)
      .eq("company_id", c.companyId)
      .select("*")
      .single();
    if (saved.error) throw Error(saved.error.message);
    return Response.json({ proof: saved.data });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Upload failed." },
      { status: 400 },
    );
  }
}

import { randomUUID } from "node:crypto";
import {
  canFill,
  proofMaxBytes,
  proofMimeAllowed,
  tasks,
} from "@/lib/ops-pulse/si-handover/model";
import { db, proofs, readChecklist } from "@/lib/ops-pulse/si-handover/server";

export const dynamic = "force-dynamic";

const bucket = "ops-pulse-documents";

export async function POST(request: Request) {
  try {
    const input = await request.json();
    const c = await readChecklist(String(input.checklistId));
    if (c.auth.readOnly) throw Error("Preview is read-only.");
    if (!canFill(c.actor, c.master.settings, c.checklist))
      return Response.json(
        { error: "Evidence is not editable for this checklist." },
        { status: 403 },
      );
    const task = tasks(c.checklist.template).find(
      (t) => t.id === String(input.taskId),
    );
    if (!task) throw Error("Choose a task from this checklist.");
    if (task.proof.kind === "none")
      throw Error("This task does not accept proof uploads.");

    const prefix = `${c.companyId}/si-handover/${c.checklist.id}/${task.id}/${c.auth.userId}/`;

    if (input.phase === "prepare") {
      const capturedAt = String(input.capturedAt || "").trim();
      if (!capturedAt || !Number.isFinite(Date.parse(capturedAt)))
        throw Error("Every proof needs a capture timestamp.");
      const lat =
        input.latitude === null || input.latitude === undefined
          ? null
          : Number(input.latitude);
      const lng =
        input.longitude === null || input.longitude === undefined
          ? null
          : Number(input.longitude);
      if (
        (lat !== null && !Number.isFinite(lat)) ||
        (lng !== null && !Number.isFinite(lng))
      )
        throw Error("GPS coordinates are invalid.");

      const name = String(input.fileName || "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 120);
      const size = Number(input.size);
      const mime = String(input.contentType || "image/jpeg").toLowerCase();
      const maxBytes = proofMaxBytes(task.proof.kind);
      if (
        !name ||
        !proofMimeAllowed(task.proof.kind, mime) ||
        !Number.isFinite(size) ||
        size < 1 ||
        size > maxBytes
      ) {
        const mb = Math.round(maxBytes / (1024 * 1024));
        throw Error(
          `Unsupported file for this task, or over ${mb} MB. Use the format shown on the task.`,
        );
      }
      // Count ready + in-flight rows so a failed confirm cannot soft-block the slot forever
      // without also consuming capacity (and clean stale not-ready rows for this user/task).
      const pending = await db()
        .from("ops_si_checklist_evidence")
        .select("id,path,ready,uploaded_by,created_at")
        .eq("company_id", c.companyId)
        .eq("checklist_id", c.checklist.id)
        .eq("task_id", task.id);
      if (pending.error) throw Error(pending.error.message);
      // Drop this user's incomplete uploads so a failed confirm can be retried.
      for (const row of pending.data || []) {
        if (!row.ready && row.uploaded_by === c.auth.userId) {
          if (row.path) await db().storage.from(bucket).remove([row.path]);
          await db()
            .from("ops_si_checklist_evidence")
            .delete()
            .eq("id", row.id)
            .eq("company_id", c.companyId);
        }
      }
      const existing = await proofs(c.companyId, c.checklist.id);
      const inFlight = (pending.data || []).filter(
        (p) => !p.ready && p.uploaded_by !== c.auth.userId,
      ).length;
      const used =
        existing.filter((p) => p.task_id === task.id).length + inFlight;
      if (used >= task.proof.max)
        throw Error(`This task permits up to ${task.proof.max} files.`);
      const id = randomUUID();
      const path = `${prefix}${id}-${name}`;
      const r = await db().from("ops_si_checklist_evidence").insert({
        id,
        company_id: c.companyId,
        checklist_id: c.checklist.id,
        task_id: task.id,
        file_name: name,
        size: Math.round(size),
        content_type: mime,
        path,
        captured_at: new Date(capturedAt).toISOString(),
        latitude: lat,
        longitude: lng,
        uploaded_by: c.auth.userId,
      });
      if (r.error) throw Error(r.error.message);
      const signed = await db()
        .storage.from(bucket)
        .createSignedUploadUrl(path);
      if (signed.error) throw Error(signed.error.message);
      return Response.json({
        id,
        path,
        token: signed.data.token,
        capturedAt: new Date(capturedAt).toISOString(),
      });
    }

    if (input.phase === "complete") {
      const id = String(input.id || "");
      const r = await db()
        .from("ops_si_checklist_evidence")
        .update({ ready: true })
        .eq("company_id", c.companyId)
        .eq("checklist_id", c.checklist.id)
        .eq("id", id)
        .eq("uploaded_by", c.auth.userId)
        .eq("ready", false)
        .select(
          "id,captured_at,file_name,content_type,size,path,task_id,created_at,latitude,longitude",
        )
        .maybeSingle();
      if (r.error) throw Error(r.error.message);
      if (!r.data) throw Error("Upload could not be confirmed.");
      return Response.json({
        proof: { ...r.data, ready: true, uploaded_by: c.auth.userId },
      });
    }

    if (input.phase === "delete") {
      const id = String(input.id || "");
      const row = await db()
        .from("ops_si_checklist_evidence")
        .select("id,path")
        .eq("company_id", c.companyId)
        .eq("checklist_id", c.checklist.id)
        .eq("id", id)
        .eq("uploaded_by", c.auth.userId)
        .maybeSingle();
      if (row.error) throw Error(row.error.message);
      if (!row.data) throw Error("Proof not found.");
      await db().storage.from(bucket).remove([row.data.path]);
      const del = await db()
        .from("ops_si_checklist_evidence")
        .delete()
        .eq("id", id)
        .eq("company_id", c.companyId);
      if (del.error) throw Error(del.error.message);
      return Response.json({ ok: true });
    }

    throw Error("Unknown upload phase.");
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Upload failed." },
      { status: 400 },
    );
  }
}

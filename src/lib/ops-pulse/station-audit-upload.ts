import { supabase } from "@/lib/supabase";
/** Stage files privately before the small report action, avoiding serverless body limits. */
export async function uploadAuditFiles(
  data: FormData,
  onProgress?: (done: number, total: number) => void,
) {
  const fields = Array.from(
    new Set([
      "erp_evidence",
      "variance_evidence",
      "evidence_files",
      "response_evidence",
      ...Array.from(data.keys()).filter(
        (key) =>
          key.startsWith("check_photo_") || key.startsWith("assessment_proof_"),
      ),
    ]),
  );
  const files = fields.flatMap((field) =>
    data
      .getAll(field)
      .filter((v): v is File => v instanceof File && v.size > 0)
      .map((file) => ({ field, file })),
  );
  if (files.length > 40)
    throw new Error("Attach up to 40 proof files at one time.");
  if (
    files.reduce((sum, entry) => sum + entry.file.size, 0) >
    120 * 1024 * 1024
  )
    throw new Error("Keep the combined proof files under 120 MB.");
  let done = 0;
  onProgress?.(done, files.length);
  for (const { file } of files)
    if (file.size > 30 * 1024 * 1024)
      throw new Error(`${file.name}: choose a file up to 30 MB.`);
  const upload = async ({ field, file }: { field: string; file: File }) => {
    if (!supabase)
      throw new Error("Upload service unavailable. Refresh and try again.");
    const call = async (body: Record<string, unknown>) => {
      const response = await fetch("/api/ops-pulse/audits/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auditId: data.get("audit_id"),
          checklistItemId: field.startsWith("check_photo_")
            ? field.slice("check_photo_".length)
            : undefined,
          ...body,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Unable to upload proof.");
      return result;
    };
    const signed = await call({
      phase: "prepare",
      fileName: file.name,
      size: file.size,
      contentType: file.type,
    });
    const uploaded = await supabase.storage
      .from(signed.bucket)
      .uploadToSignedUrl(signed.path, signed.token, file, {
        contentType: file.type || "application/octet-stream",
      });
    if (uploaded.error) throw new Error(uploaded.error.message);
    const completed = await call({
      phase: "complete",
      path: signed.path,
      kind:
        field === "erp_evidence"
          ? "erp_screenshot"
          : field === "variance_evidence"
            ? "cash_variance"
            : "document",
    });
    if (field.startsWith("assessment_proof_"))
      data.set(
        `assessment_evidence_${field.slice("assessment_proof_".length)}`,
        completed.evidenceId,
      );
    onProgress?.(++done, files.length);
  };
  for (let index = 0; index < files.length; index += 3)
    await Promise.all(files.slice(index, index + 3).map(upload));
  for (const field of fields) data.delete(field);
}

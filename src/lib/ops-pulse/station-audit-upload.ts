import { supabase } from "@/lib/supabase";
/** Stage files privately before the small report action, avoiding serverless body limits. */
export async function uploadAuditFiles(data: FormData) {
  const fields = [
    "erp_evidence",
    "variance_evidence",
    "evidence_files",
    "response_evidence",
  ];
  const files = fields.flatMap((field) =>
    data
      .getAll(field)
      .filter((v): v is File => v instanceof File && v.size > 0)
      .map((file) => ({ field, file })),
  );
  if (files.length > 8)
    throw new Error("Attach up to 8 proof files at one time.");
  for (const { file } of files)
    if (file.size > 30 * 1024 * 1024)
      throw new Error(`${file.name}: choose a file up to 30 MB.`);
  for (const { field, file } of files) {
    if (!supabase)
      throw new Error("Upload service unavailable. Refresh and try again.");
    const call = async (body: Record<string, unknown>) => {
      const response = await fetch("/api/ops-pulse/audits/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auditId: data.get("audit_id"), ...body }),
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
    await call({
      phase: "complete",
      path: signed.path,
      kind:
        field === "erp_evidence"
          ? "erp_screenshot"
          : field === "variance_evidence"
            ? "cash_variance"
            : "document",
    });
  }
  for (const field of fields) data.delete(field);
}

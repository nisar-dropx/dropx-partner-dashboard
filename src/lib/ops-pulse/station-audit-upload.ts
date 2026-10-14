import { supabase } from "@/lib/supabase";

const proofMime = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const documentMimeByExtension: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
};
const proofMimeByExtension: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};
const kindFor = (field: string) =>
  field === "erp_evidence"
    ? "erp_screenshot"
    : field === "variance_evidence"
      ? "cash_variance"
      : "document";
/** Browsers often report no type for spreadsheets, so fall back to the file extension. */
function auditFileType(field: string, file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const supporting =
    field === "evidence_files" ||
    field === "response_evidence" ||
    field.startsWith("check_photo_");
  const type =
    proofMime.test(file.type)
      ? file.type
      : proofMimeByExtension[extension] ||
        (supporting ? documentMimeByExtension[extension] : "") ||
        "";
  if (!type)
    throw new Error(
      supporting
        ? `${file.name}: this file type cannot be attached. Use a JPG, PNG, WEBP, HEIC, PDF, Excel or CSV file.`
        : `${file.name}: this file type cannot be attached here. Use a JPG, PNG, WEBP, HEIC or PDF.`,
    );
  return type;
}
/** Stage files privately before the small report action, avoiding serverless body limits. */
export type UploadedAuditFile = {
  field: string;
  evidenceId: string;
  fileName: string;
  contentType: string;
  checklistItemId: string | null;
  evidenceKind: string;
};
export async function uploadAuditFiles(
  data: FormData,
  onProgress?: (done: number, total: number) => void,
  onUploaded?: (file: UploadedAuditFile) => void,
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
  for (const { field, file } of files) {
    if (file.size > 30 * 1024 * 1024)
      throw new Error(`${file.name}: choose a file up to 30 MB.`);
    // Reject an unsupported file before anything is uploaded, naming the file.
    auditFileType(field, file);
  }
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
    const contentType = auditFileType(field, file);
    const kind = kindFor(field);
    const signed = await call({
      phase: "prepare",
      fileName: file.name,
      size: file.size,
      contentType,
      kind,
    });
    const uploaded = await supabase.storage
      .from(signed.bucket)
      .uploadToSignedUrl(signed.path, signed.token, file, {
        contentType,
      });
    if (uploaded.error) throw new Error(uploaded.error.message);
    const completed = await call({
      phase: "complete",
      path: signed.path,
      kind,
    });
    if (field.startsWith("assessment_proof_"))
      data.set(
        `assessment_evidence_${field.slice("assessment_proof_".length)}`,
        completed.evidenceId,
      );
    const checklistItemId = field.startsWith("check_photo_")
      ? field.slice("check_photo_".length)
      : null;
    onUploaded?.({
      field,
      evidenceId: completed.evidenceId,
      fileName: file.name,
      contentType,
      checklistItemId,
      evidenceKind: checklistItemId ? "checklist_photo" : kind,
    });
    onProgress?.(++done, files.length);
  };
  for (let index = 0; index < files.length; index += 3)
    await Promise.all(files.slice(index, index + 3).map(upload));
  for (const field of fields) data.delete(field);
}

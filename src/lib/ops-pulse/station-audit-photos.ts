export const auditPhotoTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
export function missingAuditPhotos(
  items: Array<{ id: string; label: string; photo_required?: boolean }>,
  evidence: Array<{
    checklist_item_id?: string | null;
    evidence_kind_code?: string | null;
    content_type?: string | null;
  }>,
) {
  return items.filter(
    (item) =>
      item.photo_required &&
      !evidence.some(
        (e) =>
          e.checklist_item_id === item.id &&
          e.evidence_kind_code === "checklist_photo" &&
          auditPhotoTypes.has(e.content_type || ""),
      ),
  );
}

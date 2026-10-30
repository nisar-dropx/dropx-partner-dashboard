const IMAGE_PROOF = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const DOCUMENT_PROOF = new Set([
  ...IMAGE_PROOF,
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
]);

function proofMatches(
  item: { photo_required?: boolean },
  evidence: { content_type?: string | null },
) {
  const type = String(evidence.content_type ?? "");
  return item.photo_required ? IMAGE_PROOF.has(type) : DOCUMENT_PROOF.has(type);
}

/**
 * Items whose `photo_required` flag is already resolved by the caller.
 * Pass `allowDocuments: true` when the flag was raised only by non-compliance
 * (Excel/PDF/CSV count); mandatory photo checks stay image-only.
 */
export function missingAuditPhotos(
  items: Array<{
    id: string;
    label: string;
    photo_required?: boolean;
    allowDocuments?: boolean;
  }>,
  evidence: Array<{
    checklist_item_id?: string | null;
    evidence_kind_code?: string | null;
    content_type?: string | null;
  }>,
) {
  return items.filter(
    (item) =>
      Boolean(item.photo_required) &&
      !evidence.some(
        (e) =>
          e.checklist_item_id === item.id &&
          e.evidence_kind_code === "checklist_photo" &&
          proofMatches(
            { photo_required: !item.allowDocuments },
            e,
          ),
      ),
  );
}

/** Same rule as submit_station_audit_report: mandatory photos need an image; non-compliance proof may be a document. */
export function missingAuditChecklistProof(
  items: Array<{
    id: string;
    label: string;
    photo_required?: boolean;
    photo_on_non_compliance?: boolean;
  }>,
  answers: Array<{ checklist_item_id: string; is_compliant: boolean | null }>,
  evidence: Array<{
    checklist_item_id?: string | null;
    evidence_kind_code?: string | null;
    content_type?: string | null;
  }>,
) {
  const failed = new Set(
    answers
      .filter((row) => row.is_compliant === false)
      .map((row) => row.checklist_item_id),
  );
  return items.filter((item) => {
    const needed =
      item.photo_required ||
      (item.photo_on_non_compliance && failed.has(item.id));
    if (!needed) return false;
    return !evidence.some(
      (e) =>
        e.checklist_item_id === item.id &&
        e.evidence_kind_code === "checklist_photo" &&
        proofMatches(
          { photo_required: Boolean(item.photo_required) },
          e,
        ),
    );
  });
}

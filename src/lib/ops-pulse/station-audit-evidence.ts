/** Accept Drive links only; never treat a pasted URL as verified sharing access. */
export function isAuditDriveLink(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "drive.google.com" &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}
export function isAuditEvidenceFolder(value: string) {
  return (
    isAuditDriveLink(value) &&
    /^\/drive\/(?:u\/\d+\/)?folders\/[a-zA-Z0-9_-]+\/?$/.test(
      new URL(value).pathname,
    )
  );
}
export function auditEvidenceError(
  required: boolean,
  link: string,
  confirmed: string,
) {
  if (!required) return "";
  if (!isAuditEvidenceFolder(link))
    return "Add the Google Drive folder containing the video-call screen recording and audit photos.";
  if (confirmed !== "yes")
    return "Confirm the recording and photos are uploaded, and the folder is shared as Anyone with the link — Viewer.";
  return "";
}
/**
 * A blank folder does not block submission once proof files and written
 * feedback are both present. A folder that was entered still has to be valid.
 */
export function auditEvidenceSubmitError(
  required: boolean,
  link: string,
  confirmed: string,
  hasFileEvidence: boolean,
  hasFeedback: boolean,
) {
  const error = auditEvidenceError(required, link, confirmed);
  if (error && !link && hasFileEvidence && hasFeedback) return "";
  return error;
}

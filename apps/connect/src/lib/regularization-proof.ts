/** Phone galleries often send image/jpg, empty MIME, or HEIC. Match by type or file name. */
const PROOF_BY_MIME = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/pjpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"]
]);

const PROOF_BY_EXTENSION = new Map([
  [".jpg", ".jpg"],
  [".jpeg", ".jpg"],
  [".png", ".png"],
  [".webp", ".webp"],
  [".heic", ".heic"],
  [".heif", ".heif"]
]);

export const REGULARIZATION_PROOF_ACCEPT = "image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif";

export function regularizationProofExtension(file: { type?: string; name?: string }) {
  const mime = String(file.type ?? "").trim().toLowerCase();
  if (PROOF_BY_MIME.has(mime)) return PROOF_BY_MIME.get(mime)!;
  const name = String(file.name ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return PROOF_BY_EXTENSION.get(name.slice(dot)) ?? "";
}

export function isRegularizationProofFile(file: { type?: string; name?: string }) {
  return Boolean(regularizationProofExtension(file));
}

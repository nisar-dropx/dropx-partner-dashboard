export const rentalDocumentMaxBytes = 4 * 1024 * 1024;
export const rentalDocumentBucket = "finance-rental-agreements";
export const rentalDocumentAccept = ".pdf,.jpg,.jpeg,.png";
export const rentalDocumentUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RentalDocument = {
  id: string;
  file_name: string;
  content_type: string;
  file_size: number;
  uploaded_at: string;
};

export function validateRentalFile(file: { name: string; size: number; type: string }) {
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > rentalDocumentMaxBytes)
    throw new Error("Choose a non-empty file up to 4 MB.");
  const extension = file.name.split(".").pop()?.toLowerCase();
  const type = extension === "pdf" ? "application/pdf"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension === "png" ? "image/png" : null;
  if (!type || (file.type && file.type !== "application/octet-stream" && file.type !== type))
    throw new Error("Upload a PDF, JPG or PNG rental agreement.");
  const name = file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
  if (!name || name.length > 180) throw new Error("Use a file name of 180 characters or fewer.");
  return { name, type, extension: type === "image/jpeg" ? "jpg" : extension! };
}

export function verifyRentalFileBytes(bytes: Uint8Array, type: string) {
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  const valid = type === "application/pdf" ? starts([37, 80, 68, 70, 45])
    : type === "image/jpeg" ? starts([255, 216, 255])
    : type === "image/png" && starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!valid) throw new Error("The file content does not match its format. Upload a valid PDF, JPG or PNG.");
}

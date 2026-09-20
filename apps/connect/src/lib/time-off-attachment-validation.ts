export const timeOffAttachmentMaxBytes = 4 * 1024 * 1024;
export function validateTimeOffAttachment(name: string, size: number, bytes: Uint8Array) {
  if (!size || size > timeOffAttachmentMaxBytes || size !== bytes.length) throw new Error("Choose an attachment up to 4 MB.");
  const extension = name.split(".").pop()?.toLowerCase();
  const isPdf = [37,80,68,70,45].every((value,index)=>bytes[index]===value);
  const isPng = [137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value);
  const isJpeg = bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const mimeType = extension==="pdf" && isPdf ? "application/pdf"
    : extension==="png" && isPng ? "image/png"
    : (extension==="jpg" || extension==="jpeg") && isJpeg ? "image/jpeg" : null;
  if (!mimeType) throw new Error("Attach a valid PDF, JPG or PNG file.");
  return { mimeType, extension: mimeType==="image/jpeg" ? "jpg" : extension!, fileName: name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-150) };
}

export type DigestAttachment = {
  filename: string;
  contentType: "text/csv; charset=utf-8" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  content: string;
  encoding: "base64";
};

/** Only inline CSV/XLSX bytes are accepted: never file paths, URLs or arbitrary mail options. */
export function digestMailAttachments(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 2) throw new Error("Invalid digest attachments.");
  let bytes = 0;
  return value.map((item) => {
    if (!item || typeof item !== "object" ||
      typeof item.filename !== "string" || !/^[a-zA-Z0-9_-]{1,140}\.(csv|xlsx)$/.test(item.filename) ||
      (item.filename.endsWith(".csv") ? item.contentType !== "text/csv; charset=utf-8" : item.contentType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") || item.encoding !== "base64" ||
      typeof item.content !== "string" || !item.content.length ||
      item.content.length > 14_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.content) || item.content.length % 4 !== 0) {
      throw new Error("Invalid digest attachment content.");
    }
    const content = Buffer.from(item.content, "base64");
    if (content.toString("base64") !== item.content) throw new Error("Invalid digest attachment encoding.");
    if (item.filename.endsWith(".xlsx") && content.subarray(0, 4).toString("hex") !== "504b0304") throw new Error("Invalid Excel attachment.");
    bytes += content.length;
    if (bytes > 10_000_000) throw new Error("Digest attachments exceed the 10 MB limit.");
    return { filename: item.filename, contentType: item.contentType, content };
  });
}

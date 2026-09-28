// Documents open from the phone after their first view: inside the DropX One app the native plugin
// keeps each file in the app's private storage (removed when the app is uninstalled), so reopening
// a payslip or insurance card never touches Supabase, Vercel or Google Drive again.

export type StoredDocument = {
  id: string;
  kind: string;
  fileName: string;
  publishedAt: string;
  downloadUrl: string;
  mimeType?: string | null;
  external?: boolean;
};

type NativeDocumentPlugin = {
  cacheDocument: (options: { key: string; url: string }) => Promise<void>;
  readCachedDocument: (options: { key: string }) => Promise<{ data: string; mimeType: string }>;
  saveDocumentToDownloads: (options: { key: string; fileName: string }) => Promise<void>;
  clearCachedDocuments: () => Promise<void>;
};

function nativeDocuments(): NativeDocumentPlugin | null {
  if (typeof window === "undefined") return null;
  const plugin = (window as Window & { Capacitor?: { Plugins?: { DropxOne?: Partial<NativeDocumentPlugin> } } })
    .Capacitor?.Plugins?.DropxOne;
  return plugin?.cacheDocument && plugin.readCachedDocument && plugin.saveDocumentToDownloads
    ? plugin as NativeDocumentPlugin
    : null;
}

// publishedAt is part of the key, so a re-issued document is fetched again instead of showing the
// old stored copy.
function storageKey(document: StoredDocument) {
  return `${document.kind}-${document.id}-${Date.parse(document.publishedAt) || 0}`;
}

function absoluteUrl(url: string) {
  return new URL(url, window.location.origin).toString();
}

function base64ToBytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function guessMimeType(document: StoredDocument, reported?: string | null) {
  const type = (reported || document.mimeType || "").toLowerCase();
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return type;
  const name = document.fileName.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (/\.jpe?g$/.test(name)) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "application/pdf";
}

/** True when this document can be shown inside the app's viewer here. */
export function canViewInApp(document: StoredDocument) {
  // A browser can't read Google Drive files directly (Drive blocks cross-site reads), so on the
  // web an insurance card opens in a new tab instead.
  return Boolean(nativeDocuments()) || !document.external;
}

export async function loadDocument(document: StoredDocument) {
  const native = nativeDocuments();
  if (native) {
    const key = storageKey(document);
    await native.cacheDocument({ key, url: absoluteUrl(document.downloadUrl) });
    const stored = await native.readCachedDocument({ key });
    return { bytes: base64ToBytes(stored.data), mimeType: guessMimeType(document, stored.mimeType) };
  }
  const response = await fetch(document.downloadUrl);
  if (!response.ok) throw new Error("Document is unavailable.");
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: guessMimeType(document, response.headers.get("content-type")?.split(";")[0])
  };
}

/** Saves the document to the phone's Downloads folder (app) or triggers a browser download. */
export async function downloadDocument(document: StoredDocument) {
  const native = nativeDocuments();
  if (native) {
    const key = storageKey(document);
    await native.cacheDocument({ key, url: absoluteUrl(document.downloadUrl) });
    await native.saveDocumentToDownloads({ key, fileName: document.fileName });
    return "Saved to Downloads › DropX One.";
  }
  if (document.external) {
    window.open(document.downloadUrl, "_blank", "noopener,noreferrer");
    return "";
  }
  const link = window.document.createElement("a");
  link.href = document.downloadUrl;
  link.download = document.fileName;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  return "";
}

/** Removes every document stored on this phone (called on logout). */
export async function clearStoredDocuments() {
  await nativeDocuments()?.clearCachedDocuments().catch(() => undefined);
}

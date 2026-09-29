import {
  BlobReader,
  ZipReader,
  Uint8ArrayWriter,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js';
import XlsxPopulate from 'xlsx-populate';

const EXCEL_NAME_RE = /\.(xlsx|xls|xlsm|xlsb|csv)$/i;

function isFileEntry(entry: Entry): entry is FileEntry {
  return !entry.directory && typeof (entry as FileEntry).getData === 'function';
}

async function listZipEntries(
  zipBytes: Uint8Array,
  password?: string,
): Promise<Entry[]> {
  const ab = zipBytes.buffer.slice(
    zipBytes.byteOffset,
    zipBytes.byteOffset + zipBytes.byteLength,
  ) as ArrayBuffer;
  const reader = new ZipReader(new BlobReader(new Blob([ab])), {
    password: password || undefined,
  });
  try {
    return await reader.getEntries();
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function readEntry(entry: FileEntry): Promise<Uint8Array> {
  return entry.getData(new Uint8ArrayWriter());
}

/**
 * From a (possibly password-encrypted) zip, extract the first spreadsheet-like entry.
 * Returns bytes + filename. Decrypts Office password when needed.
 */
export async function extractPasswordProtectedExcelFromZip(
  zipBytes: Uint8Array,
  password: string,
): Promise<{ fileName: string; bytes: Uint8Array; contentType: string }> {
  let entries: Entry[];
  // Prefer password first — Amazon EDSP zips are typically encrypted archives.
  if (password) {
    try {
      entries = await listZipEntries(zipBytes, password);
    } catch {
      entries = await listZipEntries(zipBytes);
    }
  } else {
    entries = await listZipEntries(zipBytes);
  }

  const names = entries.filter((e) => !e.directory).map((e) => e.filename);
  const candidates = entries
    .filter((e): e is FileEntry => isFileEntry(e) && EXCEL_NAME_RE.test(e.filename))
    .sort((a, b) => a.filename.length - b.filename.length);

  if (candidates.length === 0) {
    throw new Error(
      `Zip contains no spreadsheet file. Entries: [${names.join(', ') || '(none)'}]`,
    );
  }

  const entry = candidates[0]!;
  let bytes: Uint8Array;
  try {
    bytes = await readEntry(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypt|password|passwd/i.test(msg) && password) {
      const withPass = await listZipEntries(zipBytes, password);
      const again = withPass.find((e): e is FileEntry => isFileEntry(e) && e.filename === entry.filename);
      if (!again) throw err;
      bytes = await readEntry(again);
    } else {
      throw err;
    }
  }

  const base = entry.filename.split('/').pop() || 'report.xlsx';
  const lower = base.toLowerCase();

  if (lower.endsWith('.csv')) {
    return { fileName: base.replace(/\s+/g, '_'), bytes, contentType: 'text/csv' };
  }

  // Decrypt / normalize workbook to unencrypted xlsx when possible.
  try {
    const workbook = await XlsxPopulate.fromDataAsync(bytes);
    const out = (await workbook.outputAsync()) as ArrayBuffer;
    return {
      fileName: base.replace(/\s+/g, '_').replace(/\.xls$/i, '.xlsx'),
      bytes: new Uint8Array(out),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  } catch {
    const workbook = await XlsxPopulate.fromDataAsync(bytes, { password });
    const out = (await workbook.outputAsync()) as ArrayBuffer;
    return {
      fileName: base.replace(/\s+/g, '_').replace(/\.xls$/i, '.xlsx'),
      bytes: new Uint8Array(out),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
}

import { Readable } from "node:stream";
import { createDeflateRaw } from "node:zlib";

type WorkbookCell = boolean | number | string | null | undefined;

type StreamingWorkbookOptions = {
  columnWidths?: number[];
  headers: string[];
  rows: Iterable<WorkbookCell[]>;
  sheetName: string;
};

function xmlText(value: unknown) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function columnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function cellXml(value: WorkbookCell, column: number, row: number, style = 0) {
  const reference = `${columnName(column)}${row}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${reference}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function rowXml(values: WorkbookCell[], row: number, style = 0) {
  return `<row r="${row}">${values.map((value, column) => cellXml(value, column, row, style)).join("")}</row>`;
}

function* worksheetXml(options: StreamingWorkbookOptions) {
  const lastColumn = columnName(Math.max(options.headers.length - 1, 0));
  yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  yield '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  yield '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  if (options.columnWidths?.length) {
    yield `<cols>${options.columnWidths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`;
  }
  yield `<sheetData>${rowXml(options.headers, 1, 1)}`;
  let rowNumber = 2;
  for (const values of options.rows) {
    yield rowXml(values, rowNumber);
    rowNumber += 1;
  }
  yield `</sheetData><autoFilter ref="A1:${lastColumn}${Math.max(rowNumber - 1, 1)}"/>`;
  yield '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
}

const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  CRC_TABLE[value] = crc >>> 0;
}

function updateCrc32(previous: number, bytes: Buffer) {
  let crc = previous ^ 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localFileHeader(name: Buffer) {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0808, 6); // UTF-8 + trailing data descriptor.
  header.writeUInt16LE(8, 8); // Deflate is streamed, so no workbook content is buffered.
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function dataDescriptor(crc: number, compressedSize: number, size: number) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc >>> 0, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

type ZipEntry = {
  content: Iterable<string | Buffer>;
  name: string;
};

type CentralEntry = {
  compressedSize: number;
  crc: number;
  name: Buffer;
  offset: number;
  size: number;
};

function centralDirectoryHeader(entry: CentralEntry) {
  const header = Buffer.alloc(46 + entry.name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  entry.name.copy(header, 46);
  return header;
}

function endOfCentralDirectory(entries: number, size: number, offset: number) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entries, 8);
  footer.writeUInt16LE(entries, 10);
  footer.writeUInt32LE(size, 12);
  footer.writeUInt32LE(offset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

async function* streamingZip(entries: ZipEntry[]) {
  const centralEntries: CentralEntry[] = [];
  let archiveOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const offset = archiveOffset;
    const header = localFileHeader(name);
    yield header;
    archiveOffset += header.length;

    let crc = 0;
    let size = 0;
    const source = Readable.from((async function* () {
      for (const value of entry.content) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
        crc = updateCrc32(crc, bytes);
        size += bytes.length;
        yield bytes;
      }
    })());
    let compressedSize = 0;
    for await (const value of source.pipe(createDeflateRaw({ level: 1 }))) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      compressedSize += bytes.length;
      archiveOffset += bytes.length;
      yield bytes;
    }

    const descriptor = dataDescriptor(crc, compressedSize, size);
    yield descriptor;
    archiveOffset += descriptor.length;
    centralEntries.push({ compressedSize, crc, name, offset, size });
  }

  const centralOffset = archiveOffset;
  for (const entry of centralEntries) {
    const header = centralDirectoryHeader(entry);
    yield header;
    archiveOffset += header.length;
  }
  yield endOfCentralDirectory(centralEntries.length, archiveOffset - centralOffset, centralOffset);
}

function values(value: string) {
  return [value];
}

export function createStreamingXlsx(options: StreamingWorkbookOptions) {
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      content: values('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>')
    },
    {
      name: "_rels/.rels",
      content: values('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    },
    {
      name: "xl/workbook.xml",
      content: values(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(options.sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: values('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
    },
    {
      name: "xl/styles.xml",
      content: values('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4511E"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: worksheetXml(options)
    }
  ];
  return Readable.from(streamingZip(entries));
}

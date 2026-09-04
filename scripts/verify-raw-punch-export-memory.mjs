import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadTypeScript(file) {
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const NativeDateTimeFormat = Intl.DateTimeFormat;
let formatterCount = 0;
Intl.DateTimeFormat = new Proxy(NativeDateTimeFormat, {
  construct(target, args) {
    formatterCount += 1;
    return Reflect.construct(target, args);
  }
});
const { formatDashboardDateTime } = await loadTypeScript("src/lib/date-format.ts");
try {
  const reference = new NativeDateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit",
    minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata"
  });
  for (const input of ["2026-07-31T18:30:00Z", "2026-08-24T13:21:00+05:30", "2026-08-31T23:59:59+05:30", new Date("2026-08-15T03:00:00Z")]) {
    assert.equal(formatDashboardDateTime(input), reference.format(new Date(input)));
  }
  assert.equal(formatDashboardDateTime(null), "-");
  assert.equal(formatDashboardDateTime("invalid", "Missing"), "Missing");
  for (let i = 0; i < 110_000; i += 1) formatDashboardDateTime("2026-08-01T00:01:00+05:30");
  assert.equal(formatterCount, 1, "Monthly exports must reuse one ICU formatter, not allocate one per cell.");
} finally {
  Intl.DateTimeFormat = NativeDateTimeFormat;
}

const { createStreamingXlsx } = await loadTypeScript("src/lib/xlsx-stream.ts");
const rowCount = Number(process.env.EXPORT_STRESS_ROWS || 1000);
function* rows() {
  for (let i = 0; i < rowCount; i += 1) {
    yield [formatDashboardDateTime("2026-08-01T00:01:00+05:30"), formatDashboardDateTime("2026-09-04T10:00:00Z"), ...Array.from({ length: 21 }, (_, c) => `source-${c}-${i}`)];
  }
}
let tail = Buffer.alloc(0);
let bytes = 0;
for await (const chunk of createStreamingXlsx({ sheetName: "Raw Punches", headers: Array.from({ length: 23 }, (_, i) => `Column ${i}`), rows: rows() })) {
  bytes += chunk.length;
  tail = Buffer.concat([tail, chunk]).subarray(-22);
}
assert.equal(tail.length, 22);
assert.equal(tail.readUInt32LE(0), 0x06054b50, "The complete ZIP directory footer must be emitted.");
const button = fs.readFileSync("src/components/raw-punch-export-button.tsx", "utf8");
assert.match(button, /blob\.slice\(-22\)/);
assert.match(button, /0x06054b50/);
console.log(`Raw punch export memory/format checks passed (${rowCount} streamed rows, ${bytes} bytes, peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB).`);

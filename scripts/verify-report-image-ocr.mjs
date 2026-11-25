/**
 * Contract checks for the free-tier Report Image OCR service.
 * Keeps Render (~512 MB) defaults wired across Python, Docker, deploy and portal.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootUrl = new URL("..", import.meta.url);
const rootDir = fileURLToPath(rootUrl);
const read = (rel) => readFileSync(new URL(rel, rootUrl), "utf8");

const mainPy = read("workers/report-image-ocr/main.py");
const dockerfile = read("workers/report-image-ocr/Dockerfile");
const renderYaml = read("workers/report-image-ocr/render.yaml");
const deploy = read("scripts/deploy-report-image-ocr-render.mjs");
const portal = read("src/lib/report-bot/image-ocr.ts");
const readme = read("workers/report-image-ocr/README.md");

test("free-tier concurrency defaults to one OCR at a time", () => {
  assert.match(mainPy, /DEFAULT_CONCURRENCY = 1/);
  assert.match(mainPy, /MAX_CONCURRENCY = 2/);
  assert.match(mainPy, /REPORT_IMAGE_OCR_CONCURRENCY/);
  assert.match(dockerfile, /REPORT_IMAGE_OCR_CONCURRENCY=1/);
  assert.match(renderYaml, /REPORT_IMAGE_OCR_CONCURRENCY[\s\S]*value: "1"/);
  assert.match(deploy, /REPORT_IMAGE_OCR_CONCURRENCY", value: "1"/);
  assert.doesNotMatch(deploy, /REPORT_IMAGE_OCR_CONCURRENCY", value: "2"/);
});

test("long-edge and upload caps stay inside free-tier RAM", () => {
  assert.match(mainPy, /DEFAULT_MAX_LONG_EDGE = 1600/);
  assert.match(mainPy, /DEFAULT_MAX_UPLOAD_MB = 8/);
  assert.match(mainPy, /HARD_MAX_UPLOAD_MB = 12/);
  assert.match(mainPy, /Image\.MAX_IMAGE_PIXELS = 40_000_000/);
  assert.match(dockerfile, /REPORT_IMAGE_OCR_MAX_LONG_EDGE=1600/);
  assert.match(dockerfile, /REPORT_IMAGE_OCR_MAX_UPLOAD_MB=8/);
  assert.match(renderYaml, /REPORT_IMAGE_OCR_MAX_LONG_EDGE[\s\S]*value: "1600"/);
  assert.match(portal, /OCR_MAX_LONG_EDGE = 1600/);
  assert.match(portal, /MAX_IMAGE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(portal, /Image is larger than 8 MB/);
});

test("memory-safe OCR path closes images and avoids MedianFilter", () => {
  assert.match(mainPy, /def _close_image/);
  assert.match(mainPy, /gc\.collect\(\)/);
  assert.match(mainPy, /\.copy\(\)/);
  assert.match(mainPy, /raw = b""/);
  // Docstrings may mention MedianFilter; runtime must not call or import it.
  assert.doesNotMatch(mainPy, /MedianFilter\s*\(/);
  assert.doesNotMatch(mainPy, /ImageFilter/);
  assert.match(dockerfile, /--workers 1/);
});

test("invalid concurrency env cannot raise above two or below one", () => {
  assert.match(mainPy, /def _env_int\(/);
  assert.match(
    mainPy,
    /OCR_CONCURRENCY = _env_int\(\s*"REPORT_IMAGE_OCR_CONCURRENCY",\s*DEFAULT_CONCURRENCY,\s*minimum=1,\s*maximum=MAX_CONCURRENCY,\s*\)/s
  );
});

test("health stays cheap and reports free-tier bounds", () => {
  assert.match(mainPy, /"min_long_edge": MIN_LONG_EDGE/);
  assert.match(mainPy, /"max_long_edge": MAX_LONG_EDGE/);
  assert.match(mainPy, /"max_upload_mb": MAX_UPLOAD_BYTES/);
  assert.match(mainPy, /not wait behind a busy OCR semaphore/);
});

test("portal still falls back when remote OCR is unavailable", () => {
  assert.match(portal, /ocrWithRemoteService/);
  assert.match(portal, /ocrWithTesseract/);
  assert.match(portal, /Fall through to local Tesseract/);
  assert.match(readme, /falls back to in-process `tesseract\.js`/);
  assert.match(readme, /Free-tier memory/);
});

test("Python memory-bound unit tests pass when worker deps are installed", (t) => {
  const probe = spawnSync(
    "python",
    ["-c", "import fastapi, PIL, pytesseract"],
    { cwd: rootDir, encoding: "utf8" }
  );
  if (probe.status !== 0) {
    // Vercel prebuild and machines without the OCR venv still rely on the source contracts above.
    t.skip("Python OCR dependencies are not installed in this environment");
    return;
  }
  const result = spawnSync(
    "python",
    ["-m", "unittest", "discover", "-s", "workers/report-image-ocr", "-p", "test_*.py", "-v"],
    { cwd: rootDir, encoding: "utf8" }
  );
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    assert.fail(detail || `python unittest exited ${result.status}`);
  }
});

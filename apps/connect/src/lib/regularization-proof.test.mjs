import assert from "node:assert/strict";
import test from "node:test";
import { isRegularizationProofFile, regularizationProofExtension } from "./regularization-proof.ts";

test("accepts phone gallery JPEG aliases and extension-only files", () => {
  assert.equal(regularizationProofExtension({ type: "image/jpg", name: "proof.jpg" }), ".jpg");
  assert.equal(regularizationProofExtension({ type: "image/pjpeg", name: "proof.jpeg" }), ".jpg");
  assert.equal(regularizationProofExtension({ type: "", name: "CCTV_proof.JPG" }), ".jpg");
  assert.equal(regularizationProofExtension({ type: "application/octet-stream", name: "out.webp" }), ".webp");
  assert.equal(regularizationProofExtension({ type: "image/heic", name: "IMG_001.HEIC" }), ".heic");
  assert.equal(isRegularizationProofFile({ type: "image/png", name: "a.png" }), true);
  assert.equal(isRegularizationProofFile({ type: "application/pdf", name: "a.pdf" }), false);
});

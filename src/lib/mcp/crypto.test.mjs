import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hashOpaqueToken, sha256Hex, verifyPkceS256 } from "./crypto.ts";

test("PKCE S256 accepts matching verifier", () => {
  const verifier = "a".repeat(43);
  const challenge = createHash("sha256").update(verifier, "utf8").digest().toString("base64url");
  assert.equal(verifyPkceS256(verifier, challenge), true);
});

test("PKCE S256 rejects wrong verifier and short verifier", () => {
  const verifier = "a".repeat(43);
  const challenge = createHash("sha256").update(verifier, "utf8").digest().toString("base64url");
  assert.equal(verifyPkceS256("b".repeat(43), challenge), false);
  assert.equal(verifyPkceS256("short", challenge), false);
});

test("opaque tokens are stored as sha256 hex hashes", () => {
  assert.equal(hashOpaqueToken("secret"), sha256Hex("secret"));
  assert.notEqual(hashOpaqueToken("secret"), "secret");
});

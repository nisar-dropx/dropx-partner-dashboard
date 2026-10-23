import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedMcpRedirectUri, normalizeRedirectUris } from "./redirect-uri.ts";

test("allows Claude callback and loopback redirects", () => {
  assert.equal(isAllowedMcpRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(isAllowedMcpRedirectUri("https://claude.ai/api/mcp/auth_callback?x=1"), true);
  assert.equal(isAllowedMcpRedirectUri("http://127.0.0.1:8787/callback"), true);
  assert.equal(isAllowedMcpRedirectUri("http://localhost:3000/cb"), true);
});

test("rejects non-Claude https and non-loopback http", () => {
  assert.equal(isAllowedMcpRedirectUri("https://evil.example/callback"), false);
  assert.equal(isAllowedMcpRedirectUri("http://192.168.1.1/cb"), false);
  assert.equal(isAllowedMcpRedirectUri("https://user:pass@claude.ai/api/mcp/auth_callback"), false);
});

test("normalizeRedirectUris drops invalid entries", () => {
  assert.deepEqual(
    normalizeRedirectUris([
      "https://claude.ai/api/mcp/auth_callback",
      "https://evil.example/x",
      "https://claude.ai/api/mcp/auth_callback"
    ]),
    ["https://claude.ai/api/mcp/auth_callback"]
  );
});

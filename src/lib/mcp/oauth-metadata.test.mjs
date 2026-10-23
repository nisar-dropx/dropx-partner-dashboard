import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  wwwAuthenticateResourceMetadataHeader
} from "./oauth-metadata.ts";

test("protected resource metadata points at Fleet /mcp", () => {
  const meta = buildProtectedResourceMetadata("https://fleet.dropxlogistics.com");
  assert.equal(meta.resource, "https://fleet.dropxlogistics.com/mcp");
  assert.deepEqual(meta.authorization_servers, ["https://fleet.dropxlogistics.com"]);
  assert.ok(meta.scopes_supported.includes("fleet.read"));
});

test("authorization server advertises PKCE S256, DCR and CIMD", () => {
  const meta = buildAuthorizationServerMetadata("https://fleet.dropxlogistics.com");
  assert.equal(meta.authorization_endpoint, "https://fleet.dropxlogistics.com/api/mcp/oauth/authorize");
  assert.equal(meta.token_endpoint, "https://fleet.dropxlogistics.com/api/mcp/oauth/token");
  assert.equal(meta.registration_endpoint, "https://fleet.dropxlogistics.com/api/mcp/oauth/register");
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.ok(meta.token_endpoint_auth_methods_supported.includes("none"));
  assert.equal(meta.client_id_metadata_document_supported, true);
});

test("WWW-Authenticate carries resource_metadata URL", () => {
  const header = wwwAuthenticateResourceMetadataHeader("https://fleet.dropxlogistics.com");
  assert.match(
    header,
    /resource_metadata="https:\/\/fleet\.dropxlogistics\.com\/\.well-known\/oauth-protected-resource"/
  );
});

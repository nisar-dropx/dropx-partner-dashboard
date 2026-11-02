import assert from "node:assert/strict";
import test from "node:test";
import { friendlyAuthLoginError } from "./auth-login-error.ts";

test("friendlyAuthLoginError maps PKCE verifier missing text", () => {
  const raw =
    "PKCE code verifier not found in storage. This can happen if the auth flow was initiated in a different browser or device, or if the storage was cleared. For SSR frameworks (Next.js, SvelteKit, etc.), use @supabase/ssr on both the server and client to store the code verifier in cookies.";
  const friendly = friendlyAuthLoginError(raw);
  assert.match(friendly, /Chrome or Safari/i);
  assert.doesNotMatch(friendly, /@supabase\/ssr/);
  assert.doesNotMatch(friendly, /dashboard\.dropxlogistics\.com/);
});

test("friendlyAuthLoginError leaves other auth errors unchanged", () => {
  assert.equal(friendlyAuthLoginError("Your account is not active."), "Your account is not active.");
});

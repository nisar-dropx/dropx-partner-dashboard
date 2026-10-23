import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomClientId(): string {
  return `mcp_${randomBytes(16).toString("hex")}`;
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const digest = createHash("sha256").update(codeVerifier, "utf8").digest();
  const computed = digest.toString("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hashOpaqueToken(token: string): string {
  return sha256Hex(token);
}

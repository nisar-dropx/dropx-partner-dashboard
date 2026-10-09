import { createHmac, timingSafeEqual } from "crypto";
import { validPreviewTarget, type PreviewTarget } from "./connect-preview-policy.ts";
export function signPreview(target: PreviewTarget, sessionToken: string, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...target, expiresAt: now + 60 * 60 * 1000 })).toString("base64url");
  return `${body}.${createHmac("sha256", sessionToken).update(body).digest("base64url")}`;
}
export function readPreview(value: string, sessionToken: string, now = Date.now()): PreviewTarget | null {
  try {
    const [body, signature, extra] = value.split(".");
    if (!sessionToken || !body || !signature || extra) return null;
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", sessionToken).update(body).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const target = JSON.parse(Buffer.from(body, "base64url").toString());
    const expiresAt = target.expiresAt;
    return validPreviewTarget(target) && typeof expiresAt === "number" && expiresAt > now ? target : null;
  } catch { return null; }
}

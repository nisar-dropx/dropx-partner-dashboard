import { createHmac, timingSafeEqual } from "node:crypto";

export function pushSignature(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
export function validPushSignature(secret: string, timestamp: string, body: string, signature: string, now = Date.now()) {
  if (!secret || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(pushSignature(secret, timestamp, body), "hex"), Buffer.from(signature, "hex"));
}

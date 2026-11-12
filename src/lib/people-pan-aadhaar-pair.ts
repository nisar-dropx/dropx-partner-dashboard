import "server-only";
import { createHash } from "node:crypto";

export function peoplePanAadhaarPairHash(panValue: unknown, aadhaarValue: unknown) {
  const pan = String(panValue ?? "").trim().toUpperCase();
  const aadhaar = String(aadhaarValue ?? "").trim().replace(/\s/g, "");
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) || !/^[0-9]{12}$/.test(aadhaar)) return null;
  return createHash("sha256").update(`${pan}|${aadhaar}`).digest("hex");
}

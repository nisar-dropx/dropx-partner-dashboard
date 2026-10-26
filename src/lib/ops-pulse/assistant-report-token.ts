import { createHmac, timingSafeEqual } from "node:crypto";
import type { AssistantRead } from "./assistant-answer";
export type AssistantReport = { version: 1; userId: string; companyId: string; stationIds: string[]; darkStore: boolean; question: string; answer: string; checkedAt: string; expiresAt: number; reads: AssistantRead[] };
export function signAssistantReport(report: AssistantReport, secret: string) {
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify(report)).toString("base64url");
  if (body.length > 1_500_000) return null;
  return body + "." + createHmac("sha256",secret).update(body).digest("base64url");
}
export function verifyAssistantReport(token: string, secret: string, actor: { userId: string; companyId: string; stationIds: string[]; darkStore: boolean }, allowedTools: string[], now = Date.now()): AssistantReport {
  if (!secret || typeof token !== "string" || token.length > 1_500_100) throw Error("Report is unavailable. Ask the question again.");
  const parts = token.split(".");
  if (parts.length !== 2) throw Error("Invalid report.");
  const given = Buffer.from(parts[1], "base64url"), expected = createHmac("sha256",secret).update(parts[0]).digest();
  if (given.length !== expected.length || !timingSafeEqual(given,expected)) throw Error("Invalid report.");
  const report = JSON.parse(Buffer.from(parts[0],"base64url").toString()) as AssistantReport;
  if (report.version !== 1 || report.userId !== actor.userId || report.companyId !== actor.companyId || report.darkStore !== actor.darkStore
    || !Array.isArray(report.stationIds) || !report.stationIds.length || report.stationIds.some(id=>!actor.stationIds.includes(id))
    || !Array.isArray(report.reads) || report.reads.some(read=>!allowedTools.includes(read.name))) throw Error("Your report permissions or selected stores have changed. Ask again in your current scope.");
  if (!Number.isFinite(report.expiresAt) || report.expiresAt < now) throw Error("Report expired. Ask again for fresh data.");
  return report;
}

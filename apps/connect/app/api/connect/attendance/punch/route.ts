import { NextRequest, NextResponse } from "next/server";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import { loadLatestBiometricPunchNeedingLocation } from "@/lib/connect-biometric-punch-location";

const dashboardUrl =
  process.env.DASHBOARD_URL?.replace(/\/$/, "") ||
  "https://dashboard.dropxlogistics.com";

async function proxy(request: NextRequest, path: string) {
  const target = new URL(path, dashboardUrl);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  const contentType = request.headers.get("content-type") ?? "";
  const init: RequestInit = {
    method: request.method,
    cache: "no-store",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
      ...(contentType && request.method !== "GET" ? { "content-type": contentType } : {})
    }
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const response = await fetch(target, init);
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}

export async function GET(request: NextRequest) {
  const target = new URL("/api/connect/attendance/punch", dashboardUrl);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  const response = await fetch(target, {
    method: "GET",
    cache: "no-store",
    headers: { cookie: request.headers.get("cookie") ?? "" }
  });
  const raw = await response.text();
  if (!response.ok) {
    return new NextResponse(raw, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
    });
  }

  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    if (!accountId) {
      return NextResponse.json(payload);
    }

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
    const punchDate = String((payload.shift as { punchDate?: string } | undefined)?.punchDate ?? "");
    if (!punchDate) return NextResponse.json(payload);

    const latestBiometricPunch = await loadLatestBiometricPunchNeedingLocation(worker, punchDate);
    return NextResponse.json({
      ...payload,
      latestBiometricPunch
    });
  } catch {
    return new NextResponse(raw, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
    });
  }
}

export async function POST(request: NextRequest) {
  return proxy(request, "/api/connect/attendance/punch");
}

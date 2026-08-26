import { NextRequest, NextResponse } from "next/server";

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
  return proxy(request, "/api/connect/attendance/punch");
}

export async function POST(request: NextRequest) {
  return proxy(request, "/api/connect/attendance/punch");
}

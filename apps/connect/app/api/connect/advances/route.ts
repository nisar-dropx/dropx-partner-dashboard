import { NextRequest, NextResponse } from "next/server";

const dashboardUrl = process.env.DASHBOARD_URL?.replace(/\/$/, "") || "https://dashboard.dropxlogistics.com";

async function forward(request: NextRequest, method: "GET" | "POST") {
  const target = new URL("/api/connect/advances", dashboardUrl);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  const response = await fetch(target, {
    method,
    cache: "no-store",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
      ...(method === "POST" ? { "content-type": request.headers.get("content-type") ?? "application/json" } : {})
    },
    body: method === "POST" ? await request.arrayBuffer() : undefined
  });
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}

export function GET(request: NextRequest) { return forward(request, "GET"); }
export function POST(request: NextRequest) { return forward(request, "POST"); }

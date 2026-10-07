import { NextRequest, NextResponse } from "next/server";
export function GET(request: NextRequest) {
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(":")[0].toLowerCase();
  if (host !== "fleet.dropxlogistics.com") return NextResponse.json([], {status:404});
  return NextResponse.json([{relation:["delegate_permission/common.handle_all_urls"],target:{namespace:"android_app",package_name:"com.dropxlogistics.fleet",sha256_cert_fingerprints:["F9:78:5E:7A:D5:F9:58:CB:C3:2B:82:F6:BD:99:47:47:2E:1E:8E:A3:58:54:2C:E4:DC:61:A9:49:13:37:09:86"]}}], {headers:{"Cache-Control":"public, max-age=3600"}});
}

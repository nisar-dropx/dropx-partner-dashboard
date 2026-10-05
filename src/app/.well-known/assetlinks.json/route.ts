import { headers } from "next/headers";
import { isFinanceHostName } from "@/lib/finance/surface";
export const dynamic = "force-dynamic";
const ops = [{"relation": ["delegate_permission/common.handle_all_urls"], "target": {"namespace": "android_app", "package_name": "com.dropxlogistics.opspulse", "sha256_cert_fingerprints": ["E4:1A:4D:81:21:43:27:61:29:A3:BC:2B:4A:E9:8F:60:35:C3:19:8A:6C:1A:23:30:A6:58:52:AE:01:EE:12:B1"]}}];
const finance = [{"relation": ["delegate_permission/common.handle_all_urls"], "target": {"namespace": "android_app", "package_name": "com.dropxlogistics.finance", "sha256_cert_fingerprints": ["6A:4C:F6:3F:65:D7:2E:DB:74:A0:38:19:93:AB:67:AB:9B:2D:D9:37:34:54:E4:0B:59:8C:6E:6B:C2:EF:AB:B0"]}}];
export function GET() { const host = headers().get("x-forwarded-host") ?? headers().get("host") ?? ""; return Response.json(isFinanceHostName(host) ? finance : ops, {headers:{"Cache-Control":"public, max-age=3600"}}); }

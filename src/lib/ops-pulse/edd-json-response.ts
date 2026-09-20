import { gzipSync } from "node:zlib";
import { NextResponse } from "next/server";
/** Compress large station cohorts before the serverless response-size limit.
 * Browser fetch transparently decodes this; exports use their own XLSX compression. */
export function eddJsonResponse(value:unknown) {
  return new NextResponse(new Uint8Array(gzipSync(JSON.stringify(value))), { headers:{
    "Content-Type":"application/json; charset=utf-8", "Content-Encoding":"gzip", "Cache-Control":"no-store"
  } });
}

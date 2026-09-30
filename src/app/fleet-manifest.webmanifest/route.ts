import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    id: "/fleet-control",
    name: "DropX Fleet",
    short_name: "Fleet",
    description: "DropX vehicle operations, audits, service, tracking and approvals.",
    start_url: "/fleet-control?source=installed_app",
    scope: "/",
    display: "standalone",
    background_color: "#f7f7f8",
    theme_color: "#202432",
    orientation: "any",
    icons: [
      { src: "/fleet-control/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/fleet-control/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/fleet-control/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  }, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } });
}

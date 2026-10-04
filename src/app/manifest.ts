import type { MetadataRoute } from "next";
import { headers } from "next/headers";
export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const host=(headers().get("x-forwarded-host") || headers().get("host") || "").split(":")[0].toLowerCase();
  if(host === "fleet.dropxlogistics.com" || host.startsWith("fleet-") || host.startsWith("dropx-fleet")) return {
    id:"/fleet-control",name:"DropX Fleet",short_name:"Fleet",description:"DropX vehicle operations, audits, service, tracking and approvals.",
    start_url:"/fleet-control?source=installed_app",scope:"/",display:"standalone",orientation:"any",background_color:"#f7f7f8",theme_color:"#202432",
    icons:[{src:"/fleet-control/icon-192.png",sizes:"192x192",type:"image/png"},{src:"/fleet-control/icon-512.png",sizes:"512x512",type:"image/png"},{src:"/fleet-control/icon-maskable-512.png",sizes:"512x512",type:"image/png",purpose:"maskable"}]
  };
  return {
    id: "https://ops.dropxlogistics.com/",
    name: "DropX OpsPulse",
    short_name: "OpsPulse",
    description: "DropX operations intelligence for station performance, capacity, cash and fleet.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f5f6fa",
    theme_color: "#ef4b22",
    categories: ["business", "productivity"],
    icons: [
      { src: "/opspulse/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/opspulse/icon-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/opspulse/icon-maskable-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}

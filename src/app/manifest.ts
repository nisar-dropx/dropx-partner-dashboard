import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { isFinanceHostName } from "@/lib/finance/surface";

export default function manifest(): MetadataRoute.Manifest {
  const host = (headers().get("x-forwarded-host") ?? headers().get("host") ?? "").split(":")[0].toLowerCase();
  if (isFinanceHostName(host)) {
    return {
      id: "https://fin.dropxlogistics.com/",
      name: "DropX Finance",
      short_name: "Fin",
      description: "DropX Finance for payment approvals, reporting and financial administration.",
      start_url: "/", scope: "/", display: "standalone",
      background_color: "#f7f6f2", theme_color: "#252b36",
      categories: ["business", "productivity"],
      icons: [
        { src: "/finance-brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/finance-brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
      ]
    };
  }
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
      { src: "/opspulse/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/opspulse/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/opspulse/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}

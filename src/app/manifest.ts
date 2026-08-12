import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
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

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { opsNavCatalogForMode } from "@/lib/ops-pulse/navigation";
import { isOpsDemoHost } from "@/lib/ops-pulse/demo/surface";
import { DemoWorkspace } from "./workspace";

export const metadata: Metadata = {
  title: "OpsPulse | Interactive demo",
  description:
    "Explore Last Mile and Q-commerce operations with fictional sample data.",
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  if (!isOpsDemoHost(headers().get("host") || "")) notFound();
  // Navigation constants only: no session, company lookup, database client or production data.
  return (
    <DemoWorkspace
      catalogs={{
        "last-mile": opsNavCatalogForMode("amazon_edsp"),
        "q-commerce": opsNavCatalogForMode("amazon_now"),
      }}
    />
  );
}

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { opsNavCatalogForMode } from "@/lib/ops-pulse/navigation";
import { isOpsDemoHost } from "@/lib/ops-pulse/demo/surface";
import { DemoWorkspace } from "../workspace";
export const metadata: Metadata = {
  title: "OpsPulse | Demo",
  robots: { index: false, follow: false },
};
export default function DemoPage({ params }: { params: { business: string } }) {
  if (!isOpsDemoHost(headers().get("host") || "")) notFound();
  if (params.business !== "last-mile" && params.business !== "dark-store")
    notFound();
  const workspace =
    params.business === "last-mile" ? "last-mile" : "q-commerce";
  return (
    <DemoWorkspace
      workspace={workspace}
      catalog={opsNavCatalogForMode(
        workspace === "last-mile" ? "amazon_edsp" : "amazon_now",
      )}
    />
  );
}

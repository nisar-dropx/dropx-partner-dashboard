import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isOpsDemoHost } from "@/lib/ops-pulse/demo/surface";
export default function DemoRedirect({
  searchParams,
}: {
  searchParams?: { workspace?: string; screen?: string };
}) {
  if (!isOpsDemoHost(headers().get("host") || "")) notFound();
  const workspace = searchParams?.workspace;
  if (workspace !== "last-mile" && workspace !== "q-commerce") notFound();
  redirect(
    `/demo/${workspace === "last-mile" ? "last-mile" : "dark-store"}${searchParams?.screen ? `?screen=${encodeURIComponent(searchParams.screen)}` : ""}`,
  );
}

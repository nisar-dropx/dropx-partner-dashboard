import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Legacy path — Live performance now lives under Operations. */
export default function LegacyDarkStoreLiveRedirect({
  searchParams
}: {
  searchParams?: { date?: string; station?: string };
}) {
  const params = new URLSearchParams();
  const date = String(searchParams?.date ?? "").trim();
  const station = String(searchParams?.station ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) params.set("date", date);
  if (station) params.set("station", station);
  const qs = params.toString();
  redirect(qs ? `/operations/live?${qs}` : "/operations/live");
}

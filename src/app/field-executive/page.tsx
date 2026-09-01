import { redirect } from "next/navigation";

type LegacySearchParams = Record<string, string | string[] | undefined>;

export default function LegacyFieldExecutivePage({
  searchParams
}: {
  searchParams?: LegacySearchParams;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
    else if (value !== undefined) query.set(key, value);
  }
  redirect(`/workforce${query.size ? `?${query.toString()}` : ""}`);
}

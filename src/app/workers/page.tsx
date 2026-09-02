import { redirect } from "next/navigation";

export default function LegacyWorkersPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
    else if (value !== undefined) query.set(key, value);
  }
  redirect(`/helpers${query.size ? `?${query.toString()}` : ""}`);
}

import { redirect } from "next/navigation";

/** Retired report: old bookmarks continue into the current COD workspace. */
export default function RetiredCodReportsPage() {
  redirect("/cod/status");
}

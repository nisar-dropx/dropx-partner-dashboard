import type { Metadata } from "next";
import { OpsAppInstall } from "@/components/ops-app-install";
import { OpsPulseBrand } from "@/components/ops-pulse-brand";

export const metadata: Metadata = { title: "Get OpsPulse", description: "Install OpsPulse on Android, Windows, Mac, iPhone and iPad." };

export default function OpsAppDownloadPage() {
  return <main className="ops-download-page">
    <header><OpsPulseBrand /><a href="/">Back to OpsPulse →</a></header>
    <h1>Your operations, one tap away.</h1>
    <p className="ops-download-intro">The same secure workspace, designed for your phone and computer.</p>
    <OpsAppInstall />
  </main>;
}

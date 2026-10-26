import type { Metadata } from "next";
import { OpsAppInstall } from "@/components/ops-app-install";
import { OpsPulseBrand } from "@/components/ops-pulse-brand";

export const metadata: Metadata = {
  title: "Get OpsPulse",
  description:
    "Get OpsPulse for Android, iPhone, Windows or Mac.",
};

export default function OpsAppDownloadPage() {
  return (
    <main className="ops-download-page">
      <header>
        <OpsPulseBrand />
        <a href="/">Back to OpsPulse →</a>
      </header>
      <h1>Your operations, one tap away.</h1>
      <p className="ops-download-intro">
        Get the Android app or install OpsPulse from your browser. Your secure
        workspace, on any device.
      </p>
      <OpsAppInstall />
    </main>
  );
}

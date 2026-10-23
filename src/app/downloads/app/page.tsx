import type { Metadata } from "next";
import { OpsAppInstall } from "@/components/ops-app-install";
import { OpsPulseBrand } from "@/components/ops-pulse-brand";

export const metadata: Metadata = {
  title: "Get OpsPulse",
  description:
    "Install OpsPulse from Chrome on your phone, or on Windows and Mac.",
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
        Until the store package is final, install OpsPulse from Chrome on your
        phone (Install app / Add to Home screen). Same secure workspace as the
        website.
      </p>
      <OpsAppInstall />
    </main>
  );
}

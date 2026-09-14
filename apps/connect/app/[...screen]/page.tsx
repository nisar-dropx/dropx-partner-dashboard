import { ConnectLoginFlow } from "@/components/connect-login-flow";
import { Suspense } from "react";

export const metadata = {
  title: { absolute: "DropX One" }
};

// The shell stays mounted so registration drafts, verification and save flows
// retain their current behaviour while each screen has a real, reloadable URL.
export default function DropXConnectScreenPage() {
  return (
    <main className="connect-page dx-web-page">
      <section className="connect-shell" aria-label="DropX One">
        <Suspense><ConnectLoginFlow /></Suspense>
      </section>
    </main>
  );
}

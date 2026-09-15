import { ConnectLoginFlow, ConnectShellFallback } from "@/components/connect-login-flow";
import { Suspense } from "react";

export const metadata = {
  title: {
    absolute: "DropX One"
  }
};

// See app/[...screen]/page.tsx's comment -- same fallback, so the very first load (this route)
// and every later tab switch (that route) look consistent instead of only one of them being fixed.
export default function DropXConnectPage() {
  return (
    <main className="connect-page dx-web-page">
      <section className="connect-shell" aria-label="DropX One">
        <Suspense fallback={<ConnectShellFallback />}><ConnectLoginFlow /></Suspense>
      </section>
    </main>
  );
}

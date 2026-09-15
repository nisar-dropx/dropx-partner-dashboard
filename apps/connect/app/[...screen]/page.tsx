import { ConnectLoginFlow, ConnectShellFallback } from "@/components/connect-login-flow";
import { Suspense } from "react";

export const metadata = {
  title: { absolute: "DropX One" }
};

// The shell stays mounted so registration drafts, verification and save flows
// retain their current behaviour while each screen has a real, reloadable URL.
//
// This Suspense boundary had no `fallback` before, so every tab switch (each one is a real
// client-side navigation to its own URL, not just a state change -- see connect-login-flow.tsx's
// `open()`/`router.push`) could make React show the boundary's default "nothing" for one frame
// before the destination screen's own in-place skeleton painted: a jarring blank flash sandwiched
// between two things that both looked fine on their own. ConnectShellFallback matches the app
// shell (header + bottom nav) so that frame now looks like part of the transition instead of a
// blank page.
export default function DropXConnectScreenPage() {
  return (
    <main className="connect-page dx-web-page">
      <section className="connect-shell" aria-label="DropX One">
        <Suspense fallback={<ConnectShellFallback />}><ConnectLoginFlow /></Suspense>
      </section>
    </main>
  );
}

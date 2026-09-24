import { Suspense, type ReactNode } from "react";
import { headers } from "next/headers";
import { ConnectLoginFlow, ConnectShellFallback } from "@/components/connect-login-flow";

// Keep the authenticated shell and its pending access checks mounted when the
// catch-all screen segment changes. Public pages remain outside this group.
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  // Google rejected a release under the Device and Network Abuse policy ("causing users to
  // download/install applications from unknown sources") over the APK-download banner
  // (ConnectAppInstallCard) that's meant for browser visitors only. That banner already had a
  // client-side check hiding it inside the native app, but the underlying HTML still contained
  // the download link/button regardless of that check — Play's review tooling isn't guaranteed
  // to execute client JS the same way a real browser session does, so it saw the link as
  // present either way. capacitor.config.ts's android.appendUserAgent tags every request the
  // native app's WebView makes with "DropXOneNative/1" — checked here, server-side, BEFORE
  // anything renders, so the download link's markup is never generated at all for native-app
  // requests, not just hidden after the fact.
  const showAppInstallCard = !headers().get("user-agent")?.includes("DropXOneNative");

  return (
    <main className="connect-page dx-web-page">
      <section className="connect-shell" aria-label="DropX One">
        <Suspense fallback={<ConnectShellFallback />}>
          <ConnectLoginFlow showAppInstallCard={showAppInstallCard} />
        </Suspense>
        {children}
      </section>
    </main>
  );
}

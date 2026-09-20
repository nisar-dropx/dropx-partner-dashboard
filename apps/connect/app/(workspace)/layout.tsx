import { Suspense, type ReactNode } from "react";
import { ConnectLoginFlow, ConnectShellFallback } from "@/components/connect-login-flow";

// Keep the authenticated shell and its pending access checks mounted when the
// catch-all screen segment changes. Public pages remain outside this group.
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <main className="connect-page dx-web-page">
      <section className="connect-shell" aria-label="DropX One">
        <Suspense fallback={<ConnectShellFallback />}><ConnectLoginFlow /></Suspense>
        {children}
      </section>
    </main>
  );
}

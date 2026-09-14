import { ConnectLoginFlow } from "@/components/connect-login-flow";
import { Suspense } from "react";

export const metadata = {
  title: {
    absolute: "DropX One"
  }
};

export default function DropXConnectPage() {
  return (
    <main className="connect-page dx-web-page">
      <section className="connect-shell" aria-label="DropX One">
        <Suspense><ConnectLoginFlow /></Suspense>
      </section>
    </main>
  );
}

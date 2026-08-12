import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { OpsPwaRegister } from "@/components/ops-pwa-register";
import "./globals.css";

function isOpsHost() {
  const host = (headers().get("x-forwarded-host") ?? headers().get("host") ?? "").split(":")[0].toLowerCase();
  return host === "ops.dropxlogistics.com" || host.startsWith("ops-");
}

export function generateMetadata(): Metadata {
  if (isOpsHost()) {
    return {
      title: { default: "DropX OpsPulse", template: "%s · DropX OpsPulse" },
      description: "DropX operations intelligence for station performance, capacity, cash and fleet.",
      applicationName: "DropX OpsPulse",
      manifest: "/manifest.webmanifest",
      appleWebApp: { capable: true, statusBarStyle: "default", title: "OpsPulse" },
      icons: {
        icon: [{ url: "/opspulse/icon-192.png", sizes: "192x192", type: "image/png" }],
        apple: [{ url: "/opspulse/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
      }
    };
  }
  return {
    title: { default: "Dashboard - DROPX LOGISTICS", template: "Dashboard - %s - DROPX LOGISTICS" },
    description: "Delivery associate onboarding, Provider ID mapping, earnings, and payroll control",
    icons: { icon: "/favicon.png", shortcut: "/favicon.png", apple: "/favicon.png" }
  };
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const opsHost = isOpsHost();
  return (
    <html lang="en">
      <body>
        {opsHost ? <OpsPwaRegister /> : null}
        {children}
      </body>
    </html>
  );
}

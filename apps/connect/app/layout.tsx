import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ConnectAppBootstrap } from "@/components/connect-app-bootstrap";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "DropX One",
    template: "%s"
  },
  description: "DropX One workspace for employees and field teams across web, tablet and mobile.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "DropX One",
    statusBarStyle: "black-translucent"
  },
  icons: {
    icon: [
      { url: "/app-icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/app-icons/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    shortcut: "/favicon.png",
    apple: "/app-icons/apple-touch-icon.png"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#15152f"
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html className={`${GeistSans.variable} ${GeistMono.variable}`} lang="en">
      <body className={GeistSans.className}>
        <ConnectAppBootstrap />
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
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
    statusBarStyle: "default"
  },
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/favicon.png"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html className={`${GeistSans.variable} ${GeistMono.variable}`} lang="en">
      <body className={GeistSans.className}>{children}</body>
    </html>
  );
}

"use client";

import { Download } from "lucide-react";

export function FleetAppInstall({ compact = false }: { compact?: boolean }) {
  return <div className={`fleet-app-install ${compact ? "compact" : ""}`}>
    <a className={compact ? "fc-button secondary" : "fleet-install-button"} download href="/downloads/DropX-Fleet.apk"><Download size={15} /> Download Android app</a>
  </div>;
}

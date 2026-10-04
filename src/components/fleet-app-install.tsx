"use client";

import { Download } from "lucide-react";

export function FleetAppInstall({ compact = false }: { compact?: boolean }) {
  return <div className={`fleet-app-install ${compact ? "compact" : ""}`}>
    <a className={compact ? "fc-button secondary" : "fleet-install-button"} download="DropX-Fleet-v2.1.0-arm64.apk" href="/downloads/DropX-Fleet-v2.1.0-arm64.apk"><Download size={15} /> Download Android app · v2.1.0 · 18 MB</a>
    {!compact ? <p>For modern Android phones. <a download="DropX-Fleet-v2.1.0-32bit.apk" href="/downloads/DropX-Fleet-v2.1.0-32bit.apk">Older 32-bit phone · 15 MB</a></p> : null}
  </div>;
}

"use client";

import { Download, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export function FleetAppInstall({ compact = false }: { compact?: boolean }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    setInstalled(standalone);
    const beforeInstall = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPromptEvent); };
    const appInstalled = () => { setInstalled(true); setPrompt(null); setHelp(false); };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", beforeInstall); window.removeEventListener("appinstalled", appInstalled); };
  }, []);

  if (installed) return compact ? null : <div className="fleet-install-ready"><Smartphone size={15} /> Fleet app installed</div>;

  async function install() {
    if (prompt) {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
      setPrompt(null);
      return;
    }
    setHelp((value) => !value);
  }

  return <div className={`fleet-app-install ${compact ? "compact" : ""}`}>
    <button className={compact ? "fc-button secondary" : "fleet-install-button"} onClick={install} type="button"><Download size={15} /> Install Fleet app</button>
    {help ? <p>On Android Chrome, open the browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p> : null}
  </div>;
}

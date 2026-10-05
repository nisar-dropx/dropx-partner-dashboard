"use client";
import { useEffect, useState } from "react";
import { Download, Smartphone } from "lucide-react";
import { financeAndroidRelease } from "@/lib/finance/android-release";
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
export function FinanceInstall() {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(window.matchMedia("(display-mode: standalone)").matches);
    const ready = (event: Event) => { event.preventDefault(); setPrompt(event as InstallEvent); };
    const done = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", ready);
    window.addEventListener("appinstalled", done);
    return () => { window.removeEventListener("beforeinstallprompt", ready); window.removeEventListener("appinstalled", done); };
  }, []);
  if (installed) return null;
  return <aside className="finance-install"><Smartphone size={24} aria-hidden="true" />
    <div><strong>Take Finance with you</strong><p>Compact views. The same live business.</p>
      <a className="finance-download" href={financeAndroidRelease.path} download><Download size={16} />Download Android APK</a>
      <small>v{financeAndroidRelease.version} · Android 7+ · {financeAndroidRelease.sizeLabel}</small>
      {prompt ? <button className="finance-install-web" onClick={async () => { await prompt.prompt(); await prompt.userChoice; setPrompt(null); }}>Install web app</button> : <small>On iPhone: Share → Add to Home Screen.</small>}
    </div>
  </aside>;
}

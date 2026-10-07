'use client';
import { useEffect, useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import release from '../../public/downloads/fleet-android.json';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
export function FleetAppInstall({ compact = false }: { compact?: boolean }) {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    setInstalled(window.matchMedia('(display-mode: standalone)').matches || document.referrer.startsWith('android-app://com.dropxlogistics.fleet'));
    const ready = (event: Event) => { event.preventDefault(); setPrompt(event as InstallEvent); };
    const done = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', ready);
    window.addEventListener('appinstalled', done);
    return () => { window.removeEventListener('beforeinstallprompt', ready); window.removeEventListener('appinstalled', done); };
  }, []);
  async function installWebApp() {
    if (!prompt) { setHelp(true); return; }
    try { await prompt.prompt(); await prompt.userChoice; } catch { setHelp(true); }
    finally { setPrompt(null); }
  }
  if (installed) return null;
  return <div className={`fleet-app-install ${compact ? 'compact' : ''}`}>
    {compact ? <button className="fc-button secondary" type="button" onClick={() => setHelp(open => !open)}><Smartphone size={18}/>Get Fleet app</button> :
      <div className="fleet-android-download">
        <div className="fleet-android-heading"><img src="/fleet-control/icon-192.png" alt="" width="44" height="44"/><div><strong>Fleet, wherever you work</strong><span>Audits · photos · tracking · approvals</span></div></div>
        <a className="fleet-install-button fleet-apk-download" href={release.url} download><Download size={19}/>Download Android app</a>
        <p>v{release.version} · {(release.bytes / 1024 / 1024).toFixed(1)} MB · Android 6+ · Online access</p>
        <button className="fleet-web-install" type="button" onClick={installWebApp}><Smartphone size={16}/>iPhone or browser? Add to home screen</button>
      </div>}
    {help && <div className="fleet-install-help" role="status">
      <button type="button" aria-label="Close installation help" onClick={() => setHelp(false)}><X size={18}/></button>
      <strong>Take Fleet with you</strong>
      <a className="fleet-install-button" href={release.url} download><Download size={18}/>Android · Download v{release.version}</a>
      <p>Android: open the downloaded APK and follow the installation prompt. Chrome should be up to date.</p>
      <p>iPhone: open Fleet in Safari, tap Share → Add to Home Screen.</p>
      {prompt ? <button className="fleet-web-install" type="button" onClick={installWebApp}>Install browser app</button> : <p>Chrome: tap ⋮ → Install app or Add to Home Screen.</p>}
      <p>Use your existing Fleet login. Your role and station access stay the same.</p>
    </div>}
  </div>;
}

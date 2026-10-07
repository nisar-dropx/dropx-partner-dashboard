"use client";

import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Phone, RefreshCw } from "lucide-react";
import { guidanceLanguages, stationGuidanceLanguage, type GuidanceLanguage } from "../lib/beta-guidance";
import type { BetaSupport } from "../lib/beta-station-support";
import type { AppAccount } from "./connect-profile-app";

type LanguageState = [boolean, Dispatch<SetStateAction<boolean>>];
const LanguageContext = createContext<LanguageState | null>(null);
export function useBetaGuidanceLanguage(): LanguageState {
  const local = useState(false);
  return useContext(LanguageContext) ?? local;
}

const copy: Record<GuidanceLanguage, { title: string; label: string; call: string; unavailable: string }> = {
  en: { title: "Need a hand?", label: "Your station team leader", call: "Call for help", unavailable: "Ask your station team to add the team leader’s contact." },
  ml: { title: "സഹായം വേണോ?", label: "നിങ്ങളുടെ സ്റ്റേഷനിലെ ടീം ലീഡർ", call: "സഹായത്തിന് വിളിക്കൂ", unavailable: "ടീം ലീഡറുടെ ഫോൺ നമ്പർ ചേർക്കാൻ സ്റ്റേഷൻ ടീമിനെ സമീപിക്കൂ." },
  ta: { title: "உதவி வேண்டுமா?", label: "உங்கள் நிலையத்தின் குழுத் தலைவர்", call: "உதவிக்கு அழையுங்கள்", unavailable: "குழுத் தலைவரின் எண்ணைச் சேர்க்க நிலையக் குழுவிடம் கேளுங்கள்." },
  te: { title: "సహాయం కావాలా?", label: "మీ స్టేషన్ టీమ్ లీడర్", call: "సహాయం కోసం కాల్ చేయండి", unavailable: "టీమ్ లీడర్ నంబర్‌ను జోడించమని స్టేషన్ బృందాన్ని అడగండి." },
  kn: { title: "ಸಹಾಯ ಬೇಕೇ?", label: "ನಿಮ್ಮ ಸ್ಟೇಷನ್ ತಂಡದ ನಾಯಕ", call: "ಸಹಾಯಕ್ಕಾಗಿ ಕರೆ ಮಾಡಿ", unavailable: "ತಂಡದ ನಾಯಕರ ಸಂಖ್ಯೆಯನ್ನು ಸೇರಿಸಲು ಸ್ಟೇಷನ್ ತಂಡವನ್ನು ಕೇಳಿ." },
  hi: { title: "मदद चाहिए?", label: "आपकी स्टेशन टीम के लीडर", call: "मदद के लिए कॉल करें", unavailable: "टीम लीडर का नंबर जोड़ने के लिए स्टेशन टीम से कहें।" },
  or: { title: "ସାହାଯ୍ୟ ଦରକାର କି?", label: "ଆପଣଙ୍କ ଷ୍ଟେସନ୍ ଟିମ୍ ଲିଡର୍", call: "ସାହାଯ୍ୟ ପାଇଁ କଲ୍ କରନ୍ତୁ", unavailable: "ଟିମ୍ ଲିଡର୍‌ଙ୍କ ନମ୍ବର ଯୋଡ଼ିବାକୁ ଷ୍ଟେସନ୍ ଟିମ୍‌କୁ କୁହନ୍ତୁ।" }
};

export function ConnectBetaJourneyShell({ account, registration, children }: { account: AppAccount; registration: boolean; children: ReactNode }) {
  const languageState = useState(false);
  const [data, setData] = useState<BetaSupport | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    let disposed = false;
    setError(false);
    const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
    void fetch(`/api/connect/beta-support?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<BetaSupport>; })
      .then(value => { if (!disposed) setData(value); })
      .catch(() => { if (!disposed) setError(true); })
      .finally(() => window.clearTimeout(timeout));
    return () => { disposed = true; controller.abort(); window.clearTimeout(timeout); };
  }, [account.id, account.profileType, attempt]);
  const regional = stationGuidanceLanguage(data?.stationState);
  const language = languageState[0] ? regional : "en";
  const text = copy[language];
  return <LanguageContext.Provider value={languageState}>
    <aside className="dx-beta-helpbar" aria-label="Station support" lang={language}>
      <div className="dx-beta-helpbar-contact"><span>{text.title}</span>{data?.leader ? <><strong>{data.leader.name}</strong><small>{text.label}{data.stationCode ? ` · ${data.stationCode}` : ""}</small>{data.leader.phone ? <a className="dx-beta-helpbar-number" href={`tel:${data.leader.phone}`}>{data.leader.phone}</a> : <small>{text.unavailable}</small>}</> : <p role="status">{error ? "Station contact couldn’t load. Try again." : data ? text.unavailable : "Finding your station team leader…"}</p>}</div>
      <div className="dx-beta-helpbar-actions">{data?.leader?.phone ? <a className="dx-beta-call" href={`tel:${data.leader.phone}`}><Phone size={18}/>{text.call}</a> : error ? <button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16}/>Try again</button> : null}
        {registration && regional !== "en" ? <button className="dx-beta-helpbar-language" type="button" onClick={() => languageState[1](value => !value)}>{language === "en" ? <>Read in <span lang={regional}>{guidanceLanguages.find(item => item.code === regional)?.label}</span></> : "Read in English"}</button> : null}
      </div>
    </aside>
    {children}
  </LanguageContext.Provider>;
}

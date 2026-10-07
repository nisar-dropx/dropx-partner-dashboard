import type { GuidanceLanguage } from "./beta-guidance";

export const betaExitNoticeVersion = "training-continuation-v1";
export const betaExitNotice: Record<GuidanceLanguage, {title:string;body:string;acknowledgement:string}> = {
  en:{title:"Before you leave: training payout",body:"Training-period payout is available only if you continue working after training. If you leave during training before starting delivery work, you will not receive the training-period payout. This does not waive any pay owed for work already performed.",acknowledgement:"I understand the training payout condition."},
  ml:{title:"തുടരാതിരിക്കുമ്പോൾ: പരിശീലനകാലത്തെ പ്രതിഫലം",body:"പരിശീലനത്തിനു ശേഷം ജോലിയിൽ തുടരുന്നവർക്ക് മാത്രമാണ് പരിശീലനകാലത്തെ പ്രതിഫലം ലഭിക്കുക. ഡെലിവറി ജോലി തുടങ്ങുന്നതിനു മുമ്പ് പരിശീലനകാലത്ത് പിന്മാറിയാൽ പരിശീലനകാലത്തെ പ്രതിഫലം ലഭിക്കില്ല. ഇതിനകം ചെയ്ത ജോലിക്ക് ലഭിക്കേണ്ട വേതനത്തിനുള്ള അവകാശം ഇതിലൂടെ ഒഴിവാക്കുന്നില്ല.",acknowledgement:"പരിശീലനകാലത്തെ പ്രതിഫലത്തിന്റെ നിബന്ധന എനിക്ക് മനസ്സിലായി."},
  ta:{title:"விலகுவதற்கு முன்: பயிற்சிக் கால ஊதியம்",body:"பயிற்சிக்குப் பிறகு தொடர்ந்து வேலை செய்தால் மட்டுமே பயிற்சிக் கால ஊதியம் கிடைக்கும். டெலிவரி வேலையைத் தொடங்குவதற்கு முன் பயிற்சிக் காலத்தில் விலகினால், பயிற்சிக் கால ஊதியம் கிடைக்காது. ஏற்கனவே செய்த வேலைக்கான ஊதிய உரிமையை இது ரத்து செய்யாது.",acknowledgement:"பயிற்சிக் கால ஊதிய நிபந்தனையைப் புரிந்துகொண்டேன்."},
  te:{title:"వెళ్లే ముందు: శిక్షణ కాలపు చెల్లింపు",body:"శిక్షణ తర్వాత పనిని కొనసాగిస్తేనే శిక్షణ కాలపు చెల్లింపు లభిస్తుంది. డెలివరీ పని ప్రారంభించకముందే శిక్షణ సమయంలో మానేస్తే శిక్షణ కాలపు చెల్లింపు లభించదు. ఇప్పటికే చేసిన పనికి రావాల్సిన వేతన హక్కును ఇది తొలగించదు.",acknowledgement:"శిక్షణ కాలపు చెల్లింపు నిబంధన నాకు అర్థమైంది."},
  kn:{title:"ಹೊರಡುವ ಮೊದಲು: ತರಬೇತಿ ಅವಧಿಯ ಪಾವತಿ",body:"ತರಬೇತಿಯ ನಂತರ ಕೆಲಸ ಮುಂದುವರಿಸಿದರೆ ಮಾತ್ರ ತರಬೇತಿ ಅವಧಿಯ ಪಾವತಿ ಸಿಗುತ್ತದೆ. ಡೆಲಿವರಿ ಕೆಲಸ ಆರಂಭಿಸುವ ಮೊದಲು ತರಬೇತಿ ಅವಧಿಯಲ್ಲಿ ಬಿಟ್ಟರೆ ತರಬೇತಿ ಅವಧಿಯ ಪಾವತಿ ಸಿಗುವುದಿಲ್ಲ. ಈಗಾಗಲೇ ಮಾಡಿದ ಕೆಲಸಕ್ಕೆ ಸಿಗಬೇಕಾದ ವೇತನದ ಹಕ್ಕನ್ನು ಇದು ರದ್ದುಪಡಿಸುವುದಿಲ್ಲ.",acknowledgement:"ತರಬೇತಿ ಅವಧಿಯ ಪಾವತಿಯ ಷರತ್ತು ನನಗೆ ಅರ್ಥವಾಗಿದೆ."},
  hi:{title:"छोड़ने से पहले: ट्रेनिंग का भुगतान",body:"ट्रेनिंग के बाद काम जारी रखने पर ही ट्रेनिंग अवधि का भुगतान मिलेगा। डिलीवरी का काम शुरू करने से पहले ट्रेनिंग के दौरान छोड़ने पर ट्रेनिंग अवधि का भुगतान नहीं मिलेगा। इससे पहले से किए गए काम के बकाया वेतन का अधिकार समाप्त नहीं होता।",acknowledgement:"मैं ट्रेनिंग भुगतान की शर्त समझता/समझती हूँ।"},
  or:{title:"ଛାଡ଼ିବା ପୂର୍ବରୁ: ତାଲିମ ଅବଧିର ପାରିଶ୍ରମିକ",body:"ତାଲିମ ପରେ କାମ ଜାରି ରଖିଲେ ହିଁ ତାଲିମ ଅବଧିର ପାରିଶ୍ରମିକ ମିଳିବ। ଡେଲିଭରି କାମ ଆରମ୍ଭ କରିବା ପୂର୍ବରୁ ତାଲିମ ସମୟରେ ଛାଡ଼ିଦେଲେ ତାଲିମ ଅବଧିର ପାରିଶ୍ରମିକ ମିଳିବ ନାହିଁ। ଏହା ପୂର୍ବରୁ କରିଥିବା କାମର ବକେୟା ଦରମା ଅଧିକାରକୁ ବାତିଲ କରେ ନାହିଁ।",acknowledgement:"ତାଲିମ ପାରିଶ୍ରମିକର ସର୍ତ୍ତ ମୁଁ ବୁଝିଛି।"}
};

// Records the notice only in the isolated beta exit request. This never calculates pay.
export function acknowledgedBetaExitNote(input:{acknowledged?:unknown;version?:unknown;note:string;requiresNote:boolean}) {
  if(input.acknowledged!==true||input.version!==betaExitNoticeVersion)throw new Error("Read and acknowledge the training payout condition before confirming.");
  const note=input.note.trim();
  if(note.length>700)throw new Error("Keep the additional detail under 700 characters.");
  if(input.requiresNote&&note.length<3)throw new Error("Add a short note for this reason.");
  return `${note}${note?"\n\n":""}[Acknowledged ${betaExitNoticeVersion}: training payout requires continuing after training; no waiver of pay owed for work already performed.]`;
}

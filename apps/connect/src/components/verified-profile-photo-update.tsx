"use client";

import { Camera, CheckCircle2, ImagePlus, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getProfileDescriptor, type FaceMatchResult } from "@/lib/face-match";
import type { AppAccount } from "./connect-profile-app";
import { SelfieCapturePanel } from "./selfie-capture-panel";

type Challenge = {
  id: string;
  required_match_percent: number;
  require_liveness: boolean;
  expires_at: string;
};

function safePhotoError(value: unknown, fallback: string) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  if (/schema|cache|table|relation|column|supabase|service role|permission|public\./i.test(message)) return fallback;
  return message || fallback;
}

export function VerifiedProfilePhotoUpdate({ account, currentPhotoUrl, onUpdated }: {
  account: AppAccount;
  currentPhotoUrl?: string | null;
  onUpdated: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [candidate, setCandidate] = useState<File | null>(null);
  const [candidateUrl, setCandidateUrl] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => () => { if (candidateUrl) URL.revokeObjectURL(candidateUrl); }, [candidateUrl]);

  async function choose(file?: File) {
    setError("");
    setNotice("");
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Choose an image file.");
    if (file.size > 8 * 1024 * 1024) return setError("Photo must be smaller than 8 MB.");
    setBusy(true);
    const url = URL.createObjectURL(file);
    try {
      await getProfileDescriptor(url);
      const response = await fetch("/api/connect/profile-photo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Face verification could not be started.");
      if (candidateUrl) URL.revokeObjectURL(candidateUrl);
      setCandidate(file);
      setCandidateUrl(url);
      setChallenge(payload.challenge);
      setScanning(true);
    } catch (reason) {
      URL.revokeObjectURL(url);
      setError(safePhotoError(reason, "Photo verification is temporarily unavailable. Please try again."));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function finish(liveSelfie: File, match: FaceMatchResult | null) {
    if (!candidate || !challenge) throw new Error("Start the profile photo update again.");
    if (!match?.ok || match.percent < challenge.required_match_percent) {
      throw new Error(`Complete the ${challenge.required_match_percent}% face match again.`);
    }
    setBusy(true);
    const form = new FormData();
    form.set("account_id", account.id);
    form.set("profile_type", account.profileType);
    form.set("challenge_id", challenge.id);
    form.set("profile_photo", candidate);
    form.set("live_selfie", liveSelfie);
    form.set("match_percent", String(match.percent));
    form.set("match_score", String(match.score));
    form.set("liveness_passed", String(challenge.require_liveness));
    try {
      const response = await fetch("/api/connect/profile-photo", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Profile photo could not be updated.");
      setScanning(false);
      setCandidate(null);
      setChallenge(null);
      if (candidateUrl) URL.revokeObjectURL(candidateUrl);
      setCandidateUrl("");
      setNotice(`Photo updated after ${payload.matchPercent}% face match.`);
      onUpdated(payload.profilePhotoUrl);
    } catch (reason) {
      setError(safePhotoError(reason, "Profile photo could not be updated. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return <section className="dx-verified-photo-card" id="profile-photo-update">
    <button
      aria-label="Choose a new profile photo"
      className="dx-verified-photo-preview"
      disabled={busy}
      onClick={() => inputRef.current?.click()}
      type="button"
    >
      {currentPhotoUrl ? <img alt="Current profile" src={currentPhotoUrl} /> : <Camera />}
      <span><ShieldCheck />Face verified update</span>
    </button>
    <div className="dx-verified-photo-copy">
      <strong>Profile photo</strong>
      <p>Quick live face check required</p>
      {error ? <em className="error"><X />{error}</em> : null}
      {notice ? <em className="success"><CheckCircle2 />{notice}</em> : null}
    </div>
    <input accept="image/*" hidden onChange={(event) => choose(event.target.files?.[0])} ref={inputRef} type="file" />
    <button className="dx-verified-photo-action" disabled={busy} onClick={() => inputRef.current?.click()} type="button"><ImagePlus />{busy ? "Preparing…" : "Change"}</button>
    {scanning && candidateUrl && challenge ? <SelfieCapturePanel
      hint={`At least ${challenge.required_match_percent}% face match required.`}
      onCapture={finish}
      onClose={() => setScanning(false)}
      profilePhotoUrl={candidateUrl}
      requireFaceMatch
      requireLiveness={challenge.require_liveness}
      requiredMatchPercent={challenge.required_match_percent}
      title="Verify your new profile photo"
    /> : null}
  </section>;
}
